(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const number = (value, digits = 0) => Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
  const precise = (value) => number(value, 6);
  const compact = (value) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const labels = { input: 'Input · uncached', cacheWrite: 'Cache write', cacheRead: 'Cache read', output: 'Output' };
  const served = Boolean(window.__factoryToken);
  let data = { issues: [], projects: [] }, selected = null, tab = 'overview', view = 'work', scope = 'task', query = '', pending = null, peek = null, lost = false;
  let mode = 'board';
  try { if (localStorage.getItem('factory-mode') === 'list') mode = 'list'; } catch { /* Unavailable storage uses the board. */ }
  let rates = { ...DEFAULT_ASSUMPTIONS }, object = 'bulb';
  try {
    const saved = JSON.parse(localStorage.getItem('factory-scenario-v1'));
    if (saved) { rates = validateAssumptions(saved.rates); if (OBJECTS[saved.object]) object = saved.object; }
  } catch { /* Invalid or unavailable storage uses explicit defaults. */ }
  const task = () => data.issues.find(i => i.id === selected);
  const status = (i) => i.blocked ? 'Blocked' : i.stage === 'ready' ? 'Ready for review' : i.stage.replaceAll('-', ' ');
  const notice = (message) => { $('notice').textContent = message; };
  const externalLink = (url, label) => /^https:\/\/github\.com\//i.test(url || '') ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>` : escape(label);
  const doc = (title, content) => `<section><h3>${escape(title)}</h3>${content ? `<pre>${escape(content)}</pre>` : '<p class="fd-caption">Not recorded yet.</p>'}</section>`;
  function saveAssumptions() {
    try { localStorage.setItem('factory-scenario-v1', JSON.stringify({ rates, object })); }
    catch { notice('Assumptions apply now, but this browser could not save them for next time.'); }
  }
  const needsYou = (i) => Boolean(i.blocked) || i.stage === 'ready';
  const failingGate = (i) => i.gates.find(g => g.status === 'failed');
  // Says what the task waits for; colour is never the only signal.
  function queueStatus(i) {
    if (i.blocked) return { text: 'Blocked · needs your answer', cls: 'fd-fail' };
    if (i.stage === 'ready') return { text: 'Ready for your review', cls: 'fd-warning' };
    const failed = failingGate(i);
    if (failed) return { text: `${failed.name} failed`, cls: 'fd-fail' };
    return { text: status(i), cls: 'fd-muted' };
  }
  const checkClass = (value) => value === 'passed' || value === 'pass' ? 'fd-pass' : value === 'failed' || value === 'fail' ? 'fd-fail' : 'fd-warning';
  const check = (value) => `<span class="${checkClass(value)}">${escape(value)}</span>`;
  function renderQueue() {
    const shown = data.issues.filter(i => `${i.title} ${i.repo} ${i.id}`.toLowerCase().includes(query.toLowerCase()));
    $('task-count').textContent = data.issues.length;
    const row = i => { const s = queueStatus(i); return `<button class="fd-row" data-task="${escape(i.id)}" aria-pressed="${i.id === selected}"><span class="fd-repo"><span>${escape(i.repo)}</span><span>${i.kind === 'review' ? 'PR ' : ''}#${escape(i.issue)}</span></span><strong>${escape(i.title)}</strong><span class="fd-status ${s.cls}">${escape(s.text)}</span><span class="fd-tokens">${i.tokens.availability === 'unavailable' ? 'Usage unavailable' : `${compact(i.tokens.fresh)} new tokens${i.tokens.availability === 'partial' ? ' · partial' : ''}`}${i.reach.length ? ` · reaches ${plural(i.reach.length, 'project')}` : ''}</span></button>`; };
    const group = (title, items) => items.length ? `<h3 class="fd-group"><span>${title}</span><span>${items.length}</span></h3>${items.map(row).join('')}` : '';
    $('tasks').innerHTML = group('NEEDS YOU', shown.filter(needsYou)) + group('IN PROGRESS', shown.filter(i => !needsYou(i))) || '<p class="fd-queue-note">No matching tasks.</p>';
  }
  function progress(i) {
    const stages = i.kind === 'review' ? data.reviewStages : data.stages;
    const at = stages.indexOf(i.stage);
    return `<ol class="fd-steps" aria-label="Stages">${stages.map((s, n) => { const skipped = i.tier === 'trivial' && n < at && (s === 'reproduce' || s === 'plan'); return `<li class="${n < at ? 'fd-done' : n === at ? 'fd-current' : ''}${skipped ? ' fd-skipped' : ''}"${n === at ? ' aria-current="step"' : ''}><span>${escape(s.replaceAll('-', ' '))}${skipped ? ' (skipped)' : ''}</span></li>`; }).join('')}</ol>`;
  }
  function renderDetail() {
    const i = task();
    if (!i) {
      $('detail').innerHTML = '<div class="fd-empty"><h1>Your workspace is ready.</h1><p>Register a project, then bring in a GitHub issue or pull request. Its progress, evidence, and usage will appear here.</p><pre>factory add app /path/to/app --verify "npm run verify"\nfactory new app#42</pre><p class="fd-caption">Use Projects to see registered repositories.</p></div>';
      return;
    }
    const tabs = [['overview', 'Overview'], ['changes', 'Changes'], ['evidence', 'Evidence'], ['agent', 'Agent activity'], ['brief', 'Task brief'], ['usage', 'Usage']];
    if (i.kind === 'review') tabs.splice(1, 0, ['review', 'Review draft']);
    if (!tabs.some(([key]) => key === tab)) tab = 'overview';
    const s = queueStatus(i);
    $('detail').innerHTML = `<div class="fd-head"><button class="fd-btn fd-back" data-back>← All tasks</button><div class="fd-kicker">${externalLink(i.url, `${i.repo} / ${i.kind === 'review' ? 'PR ' : ''}#${i.issue}`)}<span class="${s.cls}">${escape(s.text)}</span>${i.tier ? `<span class="fd-muted">${escape(i.tier)} tier</span>` : ''}</div><h1>${escape(i.title)}</h1><div class="fd-branch">${escape(i.branch)} · ${escape((i.head || 'worktree missing').slice(0, 12))} · base ${escape(i.base)}</div>${progress(i)}</div><div class="fd-tabs" aria-label="Task sections">${tabs.map(([key, title]) => `<button data-tab="${key}" aria-pressed="${tab === key}">${title}</button>`).join('')}</div><div class="fd-body" id="body"></div><footer class="fd-footer"><div class="fd-actions">${served && i.approvalKey ? '<button class="fd-btn fd-primary" data-action="approve">Approve this version</button>' : ''}${served ? '<button class="fd-btn" data-action="archive">Archive task</button>' : ''}${i.prUrl ? externalLink(i.prUrl, 'Open pull request') : ''}</div><small>${i.approvalKey ? 'Approval covers the displayed commit and draft. It does not push, merge, or post.' : 'Checks and evidence stay tied to their recorded commit.'}</small></footer>`;
    if (tab === 'usage') renderUsage(i);
    else if (tab === 'overview') renderOverview(i);
    else if (tab === 'agent') $('body').innerHTML = agentActivity(i);
    else if (tab === 'brief') $('body').innerHTML = doc('Issue or pull request', i.docs.issue || i.docs.pr) + doc('Triage', i.docs.triage) + doc('Open questions', i.docs.questions) + doc('Plan', i.docs.plan) + doc('PR description', i.docs.prBody);
    else if (tab === 'review') $('body').innerHTML = doc('Review draft', i.docs.review);
    else if (tab === 'evidence') renderEvidence(i);
    else renderChanges(i);
  }
  const checksTable = (i) => `<div class="fd-evidence">${i.gates.map(g => `<div><span>${escape(g.name)}</span><span>${check(g.status)}${g.verifier ? ` · verifier ${check(g.verifier)}` : ''}</span></div>`).join('') || '<p>No gates configured for this project.</p>'}${i.regress ? `<div><span>Regression proof</span><span>${check(i.regress)}</span></div>` : ''}${i.kind === 'review' ? '' : `<div><span>Verifier verdict</span><span>${i.verdict ? check(i.verdict) : '<span class="fd-muted">not recorded</span>'}</span></div>`}</div>`;
  function renderOverview(i) {
    const next = i.blocked
      ? `<p class="fd-fail">${escape(i.blocked)}</p>${i.docs.questions ? `<h4>Draft questions</h4><pre>${escape(i.docs.questions)}</pre>` : ''}<p class="fd-caption">After the questions are answered, resume the task:</p><pre>factory unblock ${escape(i.id)}</pre>`
      : i.stage === 'ready'
        ? `<p>All checks for this version are recorded. Read the changes, the evidence and the ${i.kind === 'review' ? 'review draft' : 'PR description'} below, then approve${served ? ' with the button at the bottom, or' : ''} in a terminal with <code>factory approve ${escape(i.id)}</code>.</p>`
        : i.needs.canAdvance
          ? `<p class="fd-pass">This stage has what it needs.</p><pre>factory advance ${escape(i.id)}</pre>`
          : `<ul class="fd-needs">${i.needs.problems.map(p => `<li>${escape(p)}</li>`).join('')}</ul>`;
    const c = i.changes;
    const draft = i.kind === 'review' ? i.docs.review : i.docs.prBody;
    const direct = i.reach.filter(r => r.depth === 1), missing = direct.filter(r => !r.mentioned);
    const reachBlock = !i.reach.length ? '' : `<section><h3>Who this change reaches</h3><p><strong>${escape(i.repo)}</strong> is used by ${plural(direct.length, 'project')} directly${i.reach.length > direct.length ? `, and reaches ${number(i.reach.length - direct.length)} more through them` : ''}. ${!i.hasPlan ? 'The plan should say what happens to each direct user under “Consumer impact”.' : missing.length ? `<span class="fd-fail">The plan’s “Consumer impact” does not name ${escape(names(missing.map(r => r.key)))}.</span> Add what happens to ${missing.length === 1 ? 'it' : 'them'}, or why ${missing.length === 1 ? 'it is' : 'they are'} unaffected.` : 'The plan names every direct user.'}</p><div class="fd-evidence">${i.reach.map(r => `<div><span>${escape(r.key)} <span class="fd-muted">· ${r.depth === 1 ? 'direct user' : `through ${escape(r.via)}`}</span></span><span>${r.mentioned ? '<span class="fd-pass">✓ named in the plan</span>' : !i.hasPlan ? '<span class="fd-muted">plan not written yet</span>' : r.depth === 1 ? '<span class="fd-fail">✕ not named in the plan</span>' : '<span class="fd-muted">not named · indirect</span>'}</span></div>`).join('')}</div><p class="fd-caption">This is a reminder, not a gate: the task can advance without it.</p><button class="fd-btn" data-show-map="${escape(i.repo)}">Show on the map</button></section>`;
    $('body').innerHTML = `<section class="fd-next"><h3>What happens next</h3>${next}</section>${reachBlock}${i.criteria.length ? `<section><h3>Acceptance criteria</h3><ul>${i.criteria.map(x => `<li>${escape(x)}</li>`).join('')}</ul><p class="fd-caption">From the plan. The verifier report says how each was checked; read it under Evidence.</p></section>` : ''}<section><h3>Checks at the current commit</h3>${i.tampered.length ? `<p class="fd-fail">Evidence integrity problem: ${escape(i.tampered.join('; '))}</p>` : ''}${checksTable(i)}</section><section><h3>Changes</h3><p>${c ? `${number(c.files)} file${c.files === 1 ? '' : 's'} changed · <span class="fd-pass">+${number(c.additions)}</span> <span class="fd-fail">−${number(c.deletions)}</span> lines against the merge base` : 'Change size unavailable: the worktree is missing.'}</p><button class="fd-btn" data-tab="changes">Read the changes</button></section>${draft ? doc(i.kind === 'review' ? 'Review draft this approval covers' : 'PR description this approval covers', draft) : ''}`;
  }
  function renderEvidence(i) {
    $('body').innerHTML = `<h3>Checks at the current commit</h3>${i.tampered.length ? `<p class="fd-fail">Evidence integrity problem: ${escape(i.tampered.join('; '))}</p>` : ''}${checksTable(i)}<h3 class="fd-gap">Recorded runs</h3>${[...i.evidence].reverse().map(r => { const state = r.stale || r.dirty ? 'stale' : r.ok ? 'pass' : 'fail'; return `<details class="fd-run"${r.log && served ? ` data-log="${escape(r.log)}"` : ''}><summary><span>${escape(r.name)}</span><span class="${state === 'stale' ? 'fd-warning' : checkClass(state)}">${state.toUpperCase()}</span><span class="fd-muted">${escape(r.actor)} · ${escape((r.sha || '').slice(0, 8))}</span></summary><p class="fd-caption">${escape(r.startedAt)}${r.durationMs !== null ? ` · ${number(r.durationMs / 1000, 1)} seconds` : ''}${r.exitCode !== null ? ` · exit ${escape(r.exitCode)}${r.expect ? `, expected to ${escape(r.expect)}` : ''}` : ''}</p>${r.cmd ? `<pre>${escape(r.cmd)}</pre>` : ''}${r.text ? `<pre>${escape(r.text)}</pre>` : ''}${r.log ? `<pre class="fd-log" hidden></pre><a class="fd-link" href="${escape(r.log)}" target="_blank" rel="noopener noreferrer">Open the full log</a>` : ''}</details>`; }).join('') || '<p class="fd-caption">No runs recorded yet.</p>'}${doc('Verifier report', i.docs.verify)}`;
  }
  // Shows the end of a recorded log inside its run the first time the run is opened.
  async function loadLog(details) {
    const box = details.querySelector('.fd-log');
    if (!box || details.dataset.loaded) return;
    details.dataset.loaded = '1';
    box.hidden = false; box.textContent = 'Loading the log…';
    try {
      const response = await fetch(details.dataset.log);
      if (!response.ok) throw new Error('The log could not be read.');
      const lines = (await response.text()).trimEnd().split('\n');
      box.textContent = (lines.length > 60 ? `… ${lines.length - 60} earlier lines are in the full log …\n` : '') + (lines.slice(-60).join('\n') || 'The command printed nothing.');
    } catch (error) { box.textContent = error.message; }
  }
  function parseDiff(text) {
    const files = []; let file = null;
    const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      if (line.startsWith('diff --git ')) { file = { name: /^diff --git a\/.* b\/(.*)$/.exec(line)?.[1] || line.slice(11), add: 0, del: 0, lines: [] }; files.push(file); continue; }
      if (!file) continue;
      const kind = line.startsWith('@@') ? 'fd-hunk' : line.startsWith('+++') || line.startsWith('---') ? 'fd-meta' : line.startsWith('+') ? 'fd-added' : line.startsWith('-') ? 'fd-removed' : file.lines.some(l => l.kind === 'fd-hunk') ? '' : 'fd-meta';
      if (kind === 'fd-added') file.add++; else if (kind === 'fd-removed') file.del++;
      file.lines.push({ kind, text: line });
    }
    return files;
  }
  async function renderChanges(i) {
    $('body').innerHTML = '<p class="fd-caption">Loading committed changes…</p>';
    if (!served) { $('body').innerHTML = '<p>Changes are available when running the local server.</p>'; return; }
    const id = i.id;
    try {
      const response = await fetch(`/api/diff?id=${encodeURIComponent(id)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load changes.');
      if (selected !== id || tab !== 'changes') return;
      const files = parseDiff(result.diff || '');
      const total = (key) => files.reduce((n, f) => n + f[key], 0);
      $('body').innerHTML = !files.length ? '<p>No committed changes against the merge base.</p>' : `<p>${number(files.length)} file${files.length === 1 ? '' : 's'} changed · <span class="fd-pass">+${number(total('add'))}</span> <span class="fd-fail">−${number(total('del'))}</span> lines. Committed changes against the merge base; uncommitted edits are excluded.</p>` + files.map(f => `<details class="fd-diff-file fd-keep"${f.lines.length > 600 ? '' : ' open'}><summary><span class="fd-path">${escape(f.name)}</span><span><span class="fd-pass">+${number(f.add)}</span> <span class="fd-fail">−${number(f.del)}</span></span></summary><div class="fd-diff">${f.lines.map(l => `<div${l.kind ? ` class="${l.kind}"` : ''}>${escape(l.text) || ' '}</div>`).join('')}</div></details>`).join('');
    } catch (error) { if (selected === id && tab === 'changes') $('body').textContent = error.message; }
  }
  function scopedUsage(i) { return scope === 'task' ? i.tokens : i.tokens.bySession?.find(session => session.id === scope); }
  function renderUsage(i) {
    if (scope !== 'task' && !i.tokens.bySession?.some(session => session.id === scope)) scope = 'task';
    $('body').innerHTML = `<h3>Token usage</h3><label>Usage scope<select id="usage-scope"><option value="task">Full task · all linked sessions</option>${(i.tokens.bySession || []).map(session => `<option value="${session.id}" ${scope === session.id ? 'selected' : ''}>${escape(session.label)} · linked ${escape(session.linkedAt || 'date unknown')}</option>`).join('')}</select></label><div id="usage-values"></div><section class="fd-energy"><div id="impact"></div><div class="fd-provenance"><strong>Illustrative scenario, not measured consumption.</strong><br>Energy rates: assumed · Provider grid: unknown</div><p class="fd-caption" id="active-assumptions"></p><label>Compare electricity with<select id="object">${Object.entries(OBJECTS).map(([key, value]) => `<option value="${key}" ${object === key ? 'selected' : ''}>${escape(value.label)}</option>`).join('')}</select></label><details id="method"><summary>How this is calculated</summary><div class="fd-method" id="method-values"></div></details><details><summary>Change assumptions</summary><form id="assumptions"><div class="fd-rates">${TOKEN_KINDS.map(key => `<label>${labels[key]} · Wh per million tokens<input name="${key}" type="number" min="0" max="1000000" step="any" required value="${rates[key]}"></label>`).join('')}<label>Carbon intensity · g CO₂e/kWh<input name="carbonIntensity" type="number" min="0" max="5000" step="any" required value="${rates.carbonIntensity}"></label></div><div class="fd-actions"><button class="fd-btn" type="submit">Apply assumptions</button><button class="fd-btn" type="button" id="reset-assumptions">Reset defaults</button></div><p class="fd-caption">Saved in this browser. Not provider measurements. Last valid assumptions stay active until you apply changes.</p><p id="rate-error" role="alert"></p></form></details></section>`;
    $('usage-scope').onchange = e => { scope = e.target.value; updateUsage(); };
    $('object').onchange = e => { object = e.target.value; saveAssumptions(); updateUsage(); };
    $('assumptions').onsubmit = e => {
      e.preventDefault();
      try {
        const form = new FormData(e.target);
        rates = validateAssumptions(Object.fromEntries([...TOKEN_KINDS, 'carbonIntensity'].map(key => [key, Number(form.get(key))])));
        saveAssumptions(); $('rate-error').textContent = ''; updateUsage();
      } catch (error) { $('rate-error').textContent = error.message; }
    };
    $('reset-assumptions').onclick = () => { rates = { ...DEFAULT_ASSUMPTIONS }; saveAssumptions(); for (const [key, value] of Object.entries(rates)) $('assumptions').elements[key].value = value; $('rate-error').textContent = ''; updateUsage(); };
    updateUsage();
  }
  function duration(hours) {
    if (hours === 0) return '0 seconds';
    if (hours < 1 / 60) return `${number(hours * 3600, 2)} seconds`;
    if (hours < 1) return `${number(hours * 60, 1)} minutes`;
    if (hours < 48) return `${number(hours, 1)} hours`;
    return `${number(hours / 24, 1)} days`;
  }
  function updateUsage() {
    const u = scopedUsage(task());
    const result = footprint(u, rates, object);
    $('usage-values').innerHTML = !result ? '<p>Usage unavailable. No attributed token records are available for this scope. Missing usage is not zero consumption.</p>' : `${u.availability === 'partial' ? '<p class="fd-warning">Partial usage: one or more linked transcript files are missing or unreadable. Scenarios cover recorded tokens only.</p>' : ''}<table class="fd-usage-table"><caption class="sr-only">Recorded token counts by category</caption><thead><tr><th scope="col">Category</th><th scope="col">Tokens</th></tr></thead><tbody>${TOKEN_KINDS.map(key => `<tr><th scope="row">${labels[key]}</th><td>${number(u[key])}</td></tr>`).join('')}<tr><th scope="row">New tokens · input + cache write + output</th><td>${number(u.fresh)}</td></tr><tr><th scope="row">Total including cache reads</th><td>${number(u.total)}</td></tr></tbody></table><p class="fd-caption">${number(u.messages)} attributed model calls. Source: Claude Code transcript records.</p>`;
    $('impact').innerHTML = result ? `<div class="fd-impacts"><div><div class="fd-energy-label">ELECTRICITY · SCENARIO</div><p class="fd-equivalent">Like ${escape(OBJECTS[object].label)} running for ≈ ${duration(result.hours)}.</p><p class="fd-caption">≈ ${number(result.wh, 3)} Wh of serving electricity</p></div><div><div class="fd-energy-label">CARBON · SCENARIO</div><p class="fd-equivalent">Like driving a gasoline car ≈ ${result.metres >= 1000 ? `${number(result.metres / 1000, 2)} km` : `${number(result.metres, 1)} metres`}.</p><p class="fd-caption">≈ ${number(result.grams, 3)} g CO₂e · operating emissions comparison</p></div></div>` : '<p class="fd-caption">Electricity and carbon comparisons become available with attributed usage.</p>';
    $('active-assumptions').textContent = `Assumed Wh per million tokens: input ${rates.input}; cache write ${rates.cacheWrite}; cache read ${rates.cacheRead}; output ${rates.output}. Carbon intensity: ${rates.carbonIntensity} g CO₂e/kWh.`;
    $('method-values').innerHTML = `<h4>Tokens → electricity</h4><p>Sum each token count × its assumed Wh-per-million rate ÷ 1,000,000. The four defaults are demonstration inputs, not published provider measurements.</p>${result ? TOKEN_KINDS.map(key => `<div class="fd-calculation"><span>${labels[key]}</span>${number(u[key])} × ${rates[key]} ÷ 1,000,000 = ${precise(result.contributions[key])} Wh</div>`).join('') + `<div class="fd-calculation">Total = ${precise(result.wh)} Wh</div>` : ''}<h4>Electricity → everyday object</h4><p>Runtime = electricity ÷ constant appliance power. Power is an example, not a measurement of your own device.</p>${result ? `<div class="fd-calculation">${precise(result.wh)} Wh ÷ ${OBJECTS[object].watts} W = ${precise(result.hours)} hours</div>` : ''}<h4>Electricity → carbon</h4><p>Emissions = electricity in kWh × assumed carbon intensity. The default 400 g CO₂e/kWh is not a known provider, region, or electricity contract.</p>${result ? `<div class="fd-calculation">${precise(result.wh)} Wh ÷ 1,000 × ${rates.carbonIntensity} g CO₂e/kWh = ${precise(result.grams)} g CO₂e</div>` : ''}<h4>Carbon → driving equivalent</h4><p>393 g CO₂e/mile ÷ 1.609344 km/mile = ${precise(CAR_GRAMS_PER_KM)} g CO₂e/km.</p>${result ? `<div class="fd-calculation">${precise(result.grams)} g ÷ ${precise(CAR_GRAMS_PER_KM)} g/km × 1,000 = ${precise(result.metres)} metres</div>` : ''}<p>Source: <a href="https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator-calculations-and-references" target="_blank" rel="noopener noreferrer">EPA greenhouse gas equivalencies</a>, average gasoline passenger vehicle, 2022 fleet data. Checked 19 Nov 2026. This supports the car comparison only, not the AI energy rates.</p><h4>What we know and what we do not</h4><p>Tokens come from linked local Claude Code transcripts. Only model calls naming this task, plus matching subagent transcripts, are counted. Unattributed conversation is omitted. A session means that session’s attributed contribution to this task, not its entire conversation. Other providers are currently unsupported.</p><p>Counts refresh at most once per minute. ${u?.missingFiles ? `${u.missingFiles} transcript file(s) missing or unreadable. ` : ''}Provider electricity, hardware, model calibration, and datacenter location are unknown. Actual consumption may differ substantially. There is no validated error range.</p><h4>Scope and exclusions</h4><p>This is a linear serving-electricity scenario, not a lifecycle footprint. No separate cooling or idle-power correction is added; inclusion depends on the rate you supply. Training, hardware manufacture, local builds, your device, and network energy are excluded. The car comparison excludes vehicle manufacture and fuel production.</p><p class="fd-method-meta">Method scenario-v1. Internal calculations use unrounded values; extra decimals explain arithmetic, not accuracy. Appliance and driving equivalents are rounded for readability.</p>`;
  }
  function renderProjects() {
    $('projects').innerHTML = '<h1>Projects</h1><p class="fd-desc">Each project supplies its own verification commands. Configuration stays on this machine.</p>' + data.projects.map(p => `<div class="fd-project"><h3>${escape(p.key)}</h3>${p.description ? `<p>${escape(p.description)}</p>` : ''}<p>${externalLink(`https://github.com/${p.remote}`, p.remote)} · base ${escape(p.baseBranch)}</p><p><code>${escape(p.dir)}</code></p>${p.gates.length ? p.gates.map(g => `<p>${escape(g.name)}: <code>${escape(g.cmd)}</code></p>`).join('') : '<p class="fd-warning">No verification gates configured.</p>'}</div>`).join('') + '<h3 style="margin-top:24px">Register another project</h3><pre>factory add app /path/to/app --verify "npm run verify"</pre><p class="fd-caption">Edit repos.json in your factory data directory to change commands, branch conventions, or project rules.</p>';
  }
  function renderActivity() {
    const events = data.issues.flatMap(i => i.history.map(h => ({ ...h, id: i.id }))).sort((a, b) => b.at.localeCompare(a.at));
    $('activity').innerHTML = '<h1>Activity</h1><p class="fd-desc">Recorded stage history for tasks currently in flight.</p>' + events.map(h => `<div class="fd-project"><p>${escape(h.id)} · <strong>${escape(h.stage)}</strong></p><p>${escape(h.note)}</p><span class="fd-caption">${escape(h.at)}</span></div>`).join('');
  }
  // Board: stages grouped by what is happening. Cards move when a stage's checks pass; they are not draggable.
  const COLUMNS = [['understand', 'Understand', 'intake · triage · reproduce · plan'], ['build', 'Build', 'implement'], ['check', 'Check', 'gates · verify'], ['you', 'Your turn', 'ready · blocked'], ['ship', 'Ship', 'approved · PR opened']];
  const columnOf = (i) => needsYou(i) ? 'you' : ['intake', 'triage', 'reproduce', 'plan'].includes(i.stage) ? 'understand' : ['implement', 'draft'].includes(i.stage) ? 'build' : ['gates', 'verify', 'checks'].includes(i.stage) ? 'check' : 'ship';
  const span = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 172800 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`; };
  const ago = (iso) => span(Date.now() - new Date(iso).getTime());
  const callText = (c) => c.kind === 'mcp' ? `MCP ${c.label}${c.detail ? ` · ${c.detail}` : ''}` : c.kind === 'skill' ? `skill ${c.label}` : c.kind === 'agent' ? `${c.label} agent` : c.detail ? `${c.label}: ${c.detail}` : c.label;
  const isActive = (i) => Boolean(i.activity.last) && Date.now() - new Date(i.activity.last.at).getTime() < i.activity.activeWindowMs;
  // The kind is written out, so the chip colour is never the only signal.
  const chip = (item) => `<span class="fd-chip fd-chip-${escape(item.kind)}">${escape(item.kind === 'mcp' ? `MCP ${item.label}` : item.kind === 'skill' ? `skill ${item.label}` : item.kind === 'agent' ? `${item.label} agent` : item.label)} ${number(item.count)}</span>`;
  const liveInner = (i) => {
    const a = i.activity;
    if (!a.recorded) return '<span class="fd-idle"></span><span class="fd-muted">No agent activity recorded</span>';
    return isActive(i) ? `<span class="fd-pulse"></span><span>${a.last.agent ? `${escape(a.last.agent)} agent` : 'Agent'} working · ${escape(callText(a.last))} · ${ago(a.last.at)} ago</span>` : `<span class="fd-idle"></span><span>Last agent activity ${ago(a.last.at)} ago</span>`;
  };
  const liveLine = (i) => `<div class="fd-live" data-live="${escape(i.id)}">${liveInner(i)}</div>`;
  const currentStage = (i) => i.activity.byStage.find(s => s.stage === i.stage);
  function renderBoard() {
    if (!data.issues.length) { $('kanban').innerHTML = '<div class="fd-empty"><h1>Your workspace is ready.</h1><p>Register a project, then bring in a GitHub issue or pull request. It appears here and moves across the board as its checks pass.</p><pre>factory add app /path/to/app --verify "npm run verify"\nfactory new app#42</pre></div>'; renderDrawer(); return; }
    const card = i => { const s = queueStatus(i), items = currentStage(i)?.items.slice(0, 5) || []; return `<button class="fd-card" data-peek="${escape(i.id)}" aria-pressed="${i.id === peek}"><span class="fd-repo"><span>${escape(i.repo)}</span><span>${i.kind === 'review' ? 'PR ' : ''}#${escape(i.issue)}</span></span><strong>${escape(i.title)}</strong><span class="fd-status ${s.cls}">${escape(needsYou(i) || failingGate(i) ? s.text : status(i))}</span><span class="fd-card-meta">${i.tier ? `${escape(i.tier)} tier · ` : ''}${ago(i.stageSince)} in stage${i.reach.length ? ` · reaches ${plural(i.reach.length, 'project')}` : ''}</span>${items.length ? `<span class="fd-chips">${items.map(chip).join('')}</span>` : ''}${liveLine(i)}</button>`; };
    $('kanban').innerHTML = COLUMNS.map(([key, title, sub]) => { const items = data.issues.filter(i => columnOf(i) === key); return `<section class="fd-col${key === 'you' ? ' fd-col-you' : ''}" aria-label="${title}"><h3><span>${title}</span><span class="fd-muted">${items.length}</span></h3><p class="fd-col-sub">${sub}</p>${items.map(card).join('') || '<p class="fd-col-empty">Nothing here.</p>'}</section>`; }).join('');
    renderDrawer();
  }
  function agentActivity(i) {
    const a = i.activity;
    const rows = a.byStage.map(s => { const at = s.stage === i.stage, ms = (s.ms || 0) + (s.since ? Date.now() - new Date(s.since).getTime() : 0), visited = s.ms !== null || s.since; return `<div class="fd-stage${at ? ' fd-stage-now' : ''}${visited ? '' : ' fd-stage-todo'}"><div class="fd-stage-name">${escape(s.stage.replaceAll('-', ' '))}<small>${visited ? `${span(ms)}${at ? ' · now' : ''}` : ''}</small></div><div>${s.items.length ? `<div class="fd-chips">${s.items.map(chip).join('')}</div>` : `<span class="fd-muted">${visited ? 'No calls recorded' : 'Not started'}</span>`}</div></div>`; }).join('');
    return `<div class="fd-now${isActive(i) ? ' fd-now-on' : ''}"><div class="fd-live" data-live="${escape(i.id)}">${liveInner(i)}</div><span class="fd-muted">${escape(status(i))} stage for ${ago(i.stageSince)} · ${a.recorded ? `${number(a.calls)} recorded call${a.calls === 1 ? '' : 's'}` : 'no hook has reported on this task'}</span></div><h3 class="fd-gap">Agent activity by stage</h3>${rows}<p class="fd-caption">Tool names and counts come from the session hooks of a supported harness. Command text beyond the program name, file paths and file contents are not stored. A call counts for this task when it runs inside the task worktree or names the task. No recorded activity means unknown, not idle.</p>`;
  }
  function renderDrawer() {
    const i = data.issues.find(x => x.id === peek);
    $('drawer').hidden = !i; $('board').classList.toggle('fd-board-open', Boolean(i));
    if (!i) { showPane('list'); return; }
    const s = queueStatus(i);
    $('drawer').innerHTML = `<button class="fd-btn fd-back" data-close>← Board</button><div class="fd-kicker">${externalLink(i.url, `${i.repo} / ${i.kind === 'review' ? 'PR ' : ''}#${i.issue}`)}<span class="${s.cls}">${escape(s.text)}</span>${i.tier ? `<span class="fd-muted">${escape(i.tier)} tier</span>` : ''}</div><h1>${escape(i.title)}</h1><div class="fd-actions"><button class="fd-btn fd-primary" data-open="overview">Open task</button><button class="fd-btn" data-open="changes">Read the changes</button><button class="fd-btn fd-drawer-close" data-close>Close</button></div>${i.needs.problems.length && !i.needs.canAdvance && i.stage !== 'ready' ? `<h3 class="fd-gap">What the stage still needs</h3><ul class="fd-needs">${i.needs.problems.map(p => `<li>${escape(p)}</li>`).join('')}</ul>` : ''}${agentActivity(i)}`;
  }
  function setMode(next) {
    mode = next;
    try { localStorage.setItem('factory-mode', mode); } catch { /* The choice applies for this visit only. */ }
    document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === mode));
    $('board').hidden = mode !== 'board'; $('list').hidden = mode !== 'list';
    showPane(mode === 'board' && peek ? 'detail' : 'list');
  }
  // Keeps "3 s ago" and the working marker current between data loads, without redrawing cards.
  function tick() {
    document.querySelectorAll('[data-live]').forEach(el => { const i = data.issues.find(x => x.id === el.dataset.live); if (i) el.innerHTML = liveInner(i); });
    if (!served) return;
    const working = data.issues.filter(isActive).length;
    $('connection').textContent = lost ? 'Disconnected · showing last loaded data' : working ? `Live · ${working} agent${working === 1 ? '' : 's'} working` : 'Live · no agent activity in the last minute';
  }
  // Map: how the registered projects depend on each other, and what a change in one of them reaches.
  let mapSel = null, mapMode = 'explore';
  const node = (key) => data.graph.nodes.find(n => n.key === key);
  const clip = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const plural = (n, word) => `${number(n)} ${word}${n === 1 ? '' : 's'}`;
  const names = (keys) => keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`;
  function layoutGraph() {
    const W = 236, H = 92, GX = 44, GY = 86, layers = [], pos = {};
    data.graph.nodes.forEach(n => (layers[n.layer] ||= []).push(n));
    const width = Math.max(...layers.map(l => l.length)) * (W + GX) - GX;
    layers.forEach((layer, index) => {
      // Places a project near the middle of what it depends on, which keeps most arrows from crossing.
      const centre = n => n.dependsOn.reduce((sum, d) => sum + pos[d.key].x, 0) / (n.dependsOn.length || 1);
      if (index) layer.sort((a, b) => centre(a) - centre(b));
      // A row sits under the projects it depends on, kept inside the drawing.
      const total = layer.length * (W + GX) - GX;
      const wanted = index ? layer.reduce((sum, n) => sum + centre(n) + W / 2, 0) / layer.length - total / 2 : (width - total) / 2;
      const start = Math.min(Math.max(wanted, 0), width - total);
      layer.forEach((n, i) => { pos[n.key] = { x: start + i * (W + GX), y: index * (H + GY) }; });
    });
    return { pos, W, H, width, height: layers.length * (H + GY) - GY };
  }
  function graphSvg() {
    const { pos, W, H, width, height } = layoutGraph(), pad = 16;
    const reached = new Map(mapMode === 'reach' && mapSel ? node(mapSel).reach.map(r => [r.key, r.depth]) : []);
    const inReach = key => key === mapSel || reached.has(key);
    const tracing = mapMode === 'reach' && mapSel;
    const edges = data.graph.nodes.flatMap(n => n.dependsOn.map(d => {
      const x1 = pos[d.key].x + W / 2, y1 = pos[d.key].y + H, x2 = pos[n.key].x + W / 2, y2 = pos[n.key].y, my = (y1 + y2) / 2;
      const hot = tracing && inReach(d.key) && reached.has(n.key);
      return `<path d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 7}" class="fd-edge${hot ? ' fd-edge-hot' : tracing ? ' fd-dim' : ''}" marker-end="url(#${hot ? 'fd-arrow-hot' : 'fd-arrow'})"/>${d.label ? `<text x="${(x1 + x2) / 2 + (x2 >= x1 ? 12 : -12)}" y="${my + 4}" text-anchor="${x2 >= x1 ? 'start' : 'end'}" class="fd-edge-label${tracing && !hot ? ' fd-dim' : ''}">${escape(clip(d.label, 28))}</text>` : ''}`;
    })).join('');
    const nodes = data.graph.nodes.map(n => {
      const p = pos[n.key], tasks = data.issues.filter(i => i.repo === n.key).length, step = n.key === mapSel && tracing ? 1 : reached.has(n.key) ? reached.get(n.key) + 1 : 0;
      const cls = n.key === mapSel ? ' fd-node-sel' : reached.has(n.key) ? ' fd-node-hit' : tracing ? ' fd-dim' : '';
      return `<g class="fd-node${cls}" data-node="${escape(n.key)}" tabindex="0" role="button" aria-pressed="${n.key === mapSel}" aria-label="${escape(`${n.key}. ${n.description || 'No description'}. Used by ${n.usedBy.length}.`)}"><title>${escape(n.description || n.key)}</title><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="4"/><text x="${p.x + 14}" y="${p.y + 27}" class="fd-node-name">${escape(clip(n.key, step ? 22 : 26))}</text><text x="${p.x + 14}" y="${p.y + 48}" class="fd-node-role">${escape(clip(n.description || 'No description yet', 30))}</text><text x="${p.x + 14}" y="${p.y + 74}" class="fd-node-meta">${n.usedBy.length ? `used by ${n.usedBy.length}` : 'nothing depends on it'}${tasks ? ` · ${plural(tasks, 'task')}` : ''}</text>${step ? `<circle cx="${p.x + W - 20}" cy="${p.y + 22}" r="12" class="fd-step"/><text x="${p.x + W - 20}" y="${p.y + 27}" text-anchor="middle" class="fd-step-n">${step}</text>` : ''}</g>`;
    }).join('');
    return `<svg viewBox="${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}" style="min-width:${Math.min(width, 520)}px;max-width:${width + pad * 2}px" class="fd-graph" role="group" aria-label="Project relationships"><defs><marker id="fd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#6f746e"/></marker><marker id="fd-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#c3aa7c"/></marker></defs>${edges}${nodes}</svg>`;
  }
  // The same relationships as an indented list, for small screens and screen readers that skip the drawing.
  function graphTree() {
    // A project used by several others appears under each, but its own users are listed only once.
    const expanded = new Set();
    const leaf = (n, label) => { const again = expanded.has(n.key); expanded.add(n.key); return `<li><button class="fd-leaf" data-node="${escape(n.key)}" aria-pressed="${n.key === mapSel}"><strong>${escape(n.key)}</strong><span class="fd-muted">${escape(n.description || 'No description yet')}${label ? ` · ${escape(label)}` : ''}${again && n.usedBy.length ? ' · its users are listed above' : ''}</span>${data.issues.filter(i => i.repo === n.key).map(i => { const s = queueStatus(i); return `<span class="${s.cls}">#${escape(i.issue)} · ${escape(s.text)}</span>`; }).join('')}</button>${n.usedBy.length && !again ? `<ul>${n.usedBy.map(u => leaf(node(u), node(u).dependsOn.find(d => d.key === n.key).label)).join('')}</ul>` : ''}</li>`; };
    return `<ul class="fd-tree">${data.graph.nodes.filter(n => !n.dependsOn.length).map(n => leaf(n, '')).join('')}</ul>`;
  }
  const miniTask = i => { const s = queueStatus(i); return `<button class="fd-mini-task" data-open-task="${escape(i.id)}"><span class="fd-muted">${escape(i.repo)} #${escape(i.issue)}</span><span>${escape(i.title)}</span><span class="${s.cls}">${escape(s.text)}</span></button>`; };
  const nodeLink = key => `<button class="fd-textlink" data-node="${escape(key)}">${escape(key)}</button>`;
  function mapPanel() {
    const g = data.graph, n = mapSel && node(mapSel);
    if (!n) {
      const linked = g.nodes.some(x => x.dependsOn.length);
      return `<div class="fd-kicker"><span>WORKSPACE MAP</span></div><h1>${plural(g.nodes.length, 'project')}</h1><p>Select a project to see what it is, what it depends on, who uses it, and what a change in it reaches.</p>${linked ? '' : `<div class="fd-next"><h3>No relationships declared yet</h3><p>Say which projects a project depends on in <code>repos.json</code>:</p><pre>"dependsOn": [{ "project": "theming", "label": "uses styles" }]</pre><p class="fd-caption"><code>factory doctor</code> suggests links it finds in package.json files.</p></div>`}${g.problems.length ? `<h3>Problems in the declared relationships</h3><ul class="fd-needs">${g.problems.map(p => `<li class="fd-fail">${escape(p)}</li>`).join('')}</ul>` : ''}${g.undeclared.length ? `<h3>Found in package.json, not declared</h3><ul class="fd-needs">${g.undeclared.map(l => `<li>${escape(l.from)} lists <code>${escape(l.package)}</code>, which ${escape(l.to)} publishes.</li>`).join('')}</ul><p class="fd-caption">Add them to <code>dependsOn</code> if they are real relationships.</p>` : ''}`;
    }
    const tasks = data.issues.filter(i => i.repo === n.key), project = data.projects.find(p => p.key === n.key);
    if (mapMode === 'reach') {
      const depth = Math.max(0, ...n.reach.map(r => r.depth)), path = [n.key, ...n.reach.map(r => r.key)];
      const along = data.issues.filter(i => path.includes(i.repo));
      return `<div class="fd-kicker"><span>WHAT A CHANGE REACHES</span></div><h1>${escape(n.key)}</h1>${n.reach.length ? `<p>Numbers show the order in which a change travels. A later step usually needs a release of the step before it.</p><ol class="fd-waves"><li><strong>${escape(n.key)}</strong><span class="fd-muted">Make the change here first.</span></li>${Array.from({ length: depth }, (_, d) => `<li><strong>${n.reach.filter(r => r.depth === d + 1).map(r => escape(r.key)).join(' · ')}</strong><span class="fd-muted">Take the new version, run this project's checks, and look at what users see.</span></li>`).join('')}</ol><p class="fd-caption">${g.nodes.length - path.length ? `Not reached: ${escape(names(g.nodes.filter(x => !path.includes(x.key)).map(x => x.key)))}.` : 'Every project in this workspace is reached.'}</p>` : '<p>Nothing in this workspace depends on this project, so a change here reaches no other project.</p>'}<h3>Open work along this path</h3>${along.map(miniTask).join('') || '<p class="fd-muted">None.</p>'}<div class="fd-actions fd-gap"><button class="fd-btn fd-primary" data-start="${escape(n.key)}">Start a task in ${escape(n.key)}</button><button class="fd-btn" data-mapmode="explore">Back to the map</button></div>`;
    }
    const pin = d => d.range ? ` · pins ${escape(d.range)}${d.version ? `, ${escape(d.to || d.key)} is at ${escape(d.version)}` : ''}` : '';
    return `<div class="fd-kicker"><span>PROJECT</span></div><h1>${escape(n.key)}</h1><p>${n.description ? escape(n.description) : '<span class="fd-muted">No description yet. Add <code>description</code> to this project in repos.json so newcomers know what it is.</span>'}</p>${n.owns ? `<p class="fd-caption">Change here when: ${escape(n.owns)}</p>` : ''}<h3>Depends on</h3>${n.dependsOn.length ? `<ul class="fd-plain">${n.dependsOn.map(d => `<li>${nodeLink(d.key)}<span class="fd-muted">${d.label ? ` · ${escape(d.label)}` : ''}${pin(d)}</span></li>`).join('')}</ul>` : '<p class="fd-muted">Nothing in this workspace.</p>'}<h3>Used by</h3>${n.usedBy.length ? `<ul class="fd-plain">${n.usedBy.map(u => { const label = node(u).dependsOn.find(d => d.key === n.key).label; return `<li>${nodeLink(u)}<span class="fd-muted">${label ? ` · ${escape(label)}` : ''}</span></li>`; }).join('')}</ul>` : '<p class="fd-muted">Nothing in this workspace.</p>'}<div class="fd-next fd-gap"><h3>If you change this project</h3><p>${n.reach.length ? `The change reaches <strong>${plural(n.reach.length, 'project')}</strong>: ${escape(names(n.reach.map(r => r.key)))}. Plan to check them before release.` : 'No other project in this workspace is affected.'}</p>${n.reach.length ? '<button class="fd-btn" data-mapmode="reach">Show what a change reaches</button>' : ''}</div><h3>Tasks in flight</h3>${tasks.map(miniTask).join('') || '<p class="fd-muted">None.</p>'}<h3>How it is checked</h3><p>${project?.gates.length ? project.gates.map(x => `<code>${escape(x.cmd)}</code>`).join(' · ') : '<span class="fd-warning">No verification gates configured.</span>'}</p><div class="fd-actions fd-gap"><button class="fd-btn fd-primary" data-start="${escape(n.key)}">Start a task here</button>${externalLink(`https://github.com/${n.remote}`, 'Open on GitHub')}</div>`;
  }
  function renderMap() {
    if (!data.graph?.nodes.length) { $('map').innerHTML = '<div class="fd-page"><h1>Workspace map</h1><p class="fd-desc">No projects are registered yet.</p><pre>factory add app /path/to/app --verify "npm run verify"</pre></div>'; return; }
    if (mapSel && !node(mapSel)) mapSel = null;
    const tracing = mapMode === 'reach' && mapSel;
    $('map').innerHTML = `<div class="fd-map"><div class="fd-canvas"><div class="fd-map-bar"><p class="fd-board-note">${tracing ? `Showing everything a change in <strong>${escape(mapSel)}</strong> reaches, in order.` : 'An arrow means: a change in the upper project reaches the lower one. Select a project to learn about it.'}</p><div class="fd-seg" role="group" aria-label="Map mode"><button data-mapmode="explore" aria-pressed="${mapMode === 'explore'}">Explore</button><button data-mapmode="reach" aria-pressed="${mapMode === 'reach'}">What a change reaches</button></div></div><div class="fd-graph-wrap">${graphSvg()}</div>${graphTree()}</div><aside class="fd-side" id="map-panel" tabindex="-1" aria-label="Project details">${mapPanel()}</aside></div>`;
  }
  function renderMetrics() {
    const m = data.metrics;
    if (!m || !m.tasks.length) { $('metrics').innerHTML = '<h1>Metrics</h1><p class="fd-desc">No implemented tasks are recorded yet. Measures appear once a task has run its gates.</p>'; return; }
    const s = m.summary, na = (value, show = String) => value === null ? '<span class="fd-muted">n/a</span>' : escape(show(value));
    const tile = (label, value, note) => `<div class="fd-tile"><span class="fd-energy-label">${label}</span><strong>${value}</strong><span class="fd-caption">${note}</span></div>`;
    $('metrics').innerHTML = '<h1>Metrics</h1><p class="fd-desc">How tasks went, derived from recorded evidence and stage history. Archived tasks are included; reviews of other people’s pull requests are not.</p>'
      + `<div class="fd-tiles">${tile('FIRST-PASS GATE RATE', na(s.firstPassRate, v => `${Math.round(v * 100)}%`), `${number(s.firstPass)} of ${number(s.withGateRuns)} tasks passed every gate on its first recorded run. ${number(s.tasks - s.withGateRuns)} without gate runs are left out.`)}${tile('MEDIAN TIME TO APPROVAL', na(s.medianHoursToApproval, v => `${number(v, 1)} h`), `${number(s.approved)} approved task${s.approved === 1 ? '' : 's'}, from intake to approval.`)}${tile('REWORK', escape(number(s.failedGateRuns + s.verifierFails + s.resets)), `${number(s.failedGateRuns)} failed gate runs · ${number(s.verifierFails)} verifier fail verdicts · ${number(s.resets)} resets after passing checks.`)}</div>`
      + `<div class="fd-table-wrap"><table class="fd-usage-table fd-metrics-table"><caption class="sr-only">Measures per task</caption><thead><tr>${['Task', 'Tier', 'Type', 'Stage', 'First pass', 'Failed runs', 'Verifier fails', 'Resets', 'Hours to approval', 'New tokens'].map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${m.tasks.map(t => `<tr><th scope="row">${escape(t.id)}</th><td>${na(t.tier)}</td><td>${na(t.type)}</td><td>${escape(t.stage)}</td><td>${t.firstPass === null ? na(null) : `<span class="${t.firstPass ? 'fd-pass' : 'fd-fail'}">${t.firstPass ? 'yes' : 'no'}</span>`}</td><td>${number(t.failedGateRuns)}</td><td>${number(t.verifierFails)}</td><td>${number(t.resets)}</td><td>${na(t.hoursToApproval, v => number(v, 1))}</td><td>${na(t.freshTokens, v => compact(v) + (t.tokensPartial ? ' · partial' : ''))}</td></tr>`).join('')}</tbody></table></div>`
      + '<p class="fd-caption">“n/a” means no data, not zero. These describe recorded work in this factory; they are not a productivity comparison.</p>';
  }
  function render() { renderQueue(); renderDetail(); renderBoard(); renderMap(); renderProjects(); renderActivity(); renderMetrics(); tick(); }
  const views = ['work', 'map', 'projects', 'activity', 'metrics'];
  const showView = (name) => document.querySelector(`[data-view="${name}"]`).click();
  const openTask = (id, to = 'overview') => { selected = id; tab = to; scope = 'task'; showView('work'); setMode('list'); renderQueue(); renderDetail(); showPane('detail'); $('detail').focus({ preventScroll: true }); };
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {
    view = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b === button));
    views.forEach(id => { $(id).hidden = id !== view; });
    $('view-title').textContent = button.textContent; $('mode').hidden = view !== 'work';
  });
  // On a small screen the queue and the detail are separate screens.
  const showPane = (pane) => { document.body.dataset.pane = pane; };
  $('search').oninput = e => { query = e.target.value; renderQueue(); };
  $('tasks').onclick = e => {
    const button = e.target.closest('[data-task]'); if (!button) return;
    selected = button.dataset.task; scope = 'task'; tab = 'overview';
    renderQueue(); renderDetail(); showPane('detail');
    if (matchMedia('(max-width:680px)').matches) { $('detail').focus(); scrollTo(0, 0); }
  };
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  const pickNode = (key, from) => { mapSel = key; renderMap(); (from === 'panel' ? $('map-panel') : document.querySelector(`#map ${from === 'tree' ? '.fd-leaf' : '.fd-node'}[data-node="${CSS.escape(key)}"]`))?.focus({ preventScroll: true }); };
  $('map').onclick = e => {
    const modeButton = e.target.closest('[data-mapmode]');
    if (modeButton) { mapMode = modeButton.dataset.mapmode; if (mapMode === 'reach' && !mapSel) mapSel = data.graph.nodes.find(n => !n.dependsOn.length && n.usedBy.length)?.key || data.graph.nodes[0].key; renderMap(); document.querySelector(`#map .fd-seg [data-mapmode="${mapMode}"]`)?.focus(); return; }
    const task = e.target.closest('[data-open-task]'); if (task) return openTask(task.dataset.openTask);
    const start = e.target.closest('[data-start]'); if (start) return openNew(start.dataset.start);
    const picked = e.target.closest('[data-node]');
    if (picked) pickNode(picked.dataset.node, picked.classList.contains('fd-leaf') ? 'tree' : picked.classList.contains('fd-textlink') ? 'panel' : 'graph');
  };
  $('map').onkeydown = e => { const picked = e.target.closest?.('.fd-node'); if (picked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickNode(picked.dataset.node, 'graph'); } };
  $('kanban').onclick = e => {
    const card = e.target.closest('[data-peek]'); if (!card) return;
    peek = card.dataset.peek; renderBoard(); showPane('detail'); $('drawer').focus({ preventScroll: true });
  };
  $('drawer').onkeydown = e => { if (e.key === 'Escape') $('drawer').querySelector('[data-close]')?.click(); };
  $('drawer').onclick = e => {
    if (e.target.closest('[data-close]')) { const id = peek; peek = null; renderBoard(); document.querySelector(`[data-peek="${CSS.escape(id)}"]`)?.focus(); return; }
    const open = e.target.closest('[data-open]'); if (!open) return;
    selected = peek; tab = open.dataset.open; scope = 'task'; setMode('list'); renderQueue(); renderDetail(); showPane('detail'); $('detail').focus({ preventScroll: true });
  };
  $('detail').addEventListener('toggle', e => { if (e.target.open && e.target.dataset?.log) loadLog(e.target); }, true);
  $('detail').onclick = e => {
    if (e.target.closest('[data-back]')) { showPane('list'); if (peek) { setMode('board'); document.querySelector(`[data-peek="${CSS.escape(peek)}"]`)?.focus(); return; } document.querySelector(`[data-task="${CSS.escape(selected)}"]`)?.focus(); return; }
    const onMap = e.target.closest('[data-show-map]');
    if (onMap) { mapSel = onMap.dataset.showMap; mapMode = 'reach'; showView('map'); renderMap(); $('map-panel').focus({ preventScroll: true }); return; }
    const button = e.target.closest('[data-tab]');
    if (button) { tab = button.dataset.tab; renderDetail(); document.querySelector(`.fd-tabs [data-tab="${tab}"]`)?.focus(); }
    const action = e.target.closest('[data-action]');
    if (action) {
      const i = task(); pending = { action: action.dataset.action, id: i.id, key: i.approvalKey };
      $('action-title').textContent = pending.action === 'approve' ? 'Approve this version?' : 'Archive this task?';
      $('action-text').textContent = pending.action === 'approve' ? `${i.id}: approval covers commit ${(i.head || '').slice(0, 12)} and the displayed draft. Read the draft and evidence before confirming. This does not push or merge.` : `${i.id}: this removes the clean worktree and hides the task. The local branch and recorded evidence are kept. Dirty worktrees are refused.`;
      $('action-dialog').showModal();
    }
  };
  $('confirm-action').onclick = async () => {
    if (!pending) return;
    const request = { ...pending };
    $('confirm-action').disabled = true;
    try {
      const response = await fetch(`/api/${request.action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Factory-Token': window.__factoryToken }, body: JSON.stringify(request) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Action failed.');
      notice(`${request.id}: ${request.action === 'approve' ? 'approved' : 'archived'}.`);
      $('action-dialog').close(); pending = null; refresh();
    } catch (error) { $('action-text').textContent = error.message; }
    finally { $('confirm-action').disabled = false; }
  };
  function newCommand() {
    const project = $('new-project').value, n = $('new-number').value;
    const valid = /^[1-9]\d*$/.test(n) && project;
    $('new-command').textContent = valid ? `factory ${$('new-kind').value} '${project}#${n}'` : 'Choose a project and enter a number.';
    $('copy-command').disabled = !valid;
  }
  // Projects are offered by what they own, so someone new can find where a change belongs.
  function chooseProject(key) {
    $('new-project').value = key;
    document.querySelectorAll('#new-choices [data-choice]').forEach(b => b.setAttribute('aria-checked', b.dataset.choice === key));
    const reached = data.graph?.nodes.find(n => n.key === key)?.reach || [];
    $('new-reach').hidden = !reached.length;
    $('new-reach').textContent = reached.length ? `A change in ${key} reaches ${names(reached.map(r => r.key))}. The plan will ask what happens to its direct users.` : '';
    newCommand();
  }
  function openNew(preselect) {
    $('new-project').innerHTML = data.projects.map(p => `<option value="${escape(p.key)}">${escape(p.key)}</option>`).join('');
    $('new-choices').innerHTML = data.projects.map(p => `<button type="button" class="fd-choice" role="radio" aria-checked="false" data-choice="${escape(p.key)}"><strong>${escape(p.key)}</strong><small>${escape(p.owns || p.description || p.remote)}</small></button>`).join('') || '<p class="fd-warning">No projects are registered yet. Run “factory add” first.</p>';
    if (data.projects.length) chooseProject(data.projects.some(p => p.key === preselect) ? preselect : data.projects[0].key); else newCommand();
    $('new-dialog').showModal();
  }
  $('new-choices').onclick = e => { const choice = e.target.closest('[data-choice]'); if (choice) chooseProject(choice.dataset.choice); };
  $('new-task').onclick = () => openNew(mapSel);
  ['new-project', 'new-kind', 'new-number'].forEach(id => $(id).oninput = newCommand);
  $('copy-command').onclick = async () => {
    try { await navigator.clipboard.writeText($('new-command').textContent); notice('Task command copied. Run it in your terminal.'); }
    catch { notice('Clipboard unavailable. Select and copy the command shown in the dialog.'); }
  };
  // The server could not build the board data, for example because repos.json is damaged.
  window.__factoryError = message => { lost = false; notice(`The board data could not be loaded: ${message}`); if (served) $('connection').textContent = 'Connected · data unavailable'; };
  window.__factoryData = next => {
    lost = false; if (!served) $('connection').textContent = 'Static snapshot';
    if (next.stamp === data.stamp) return;
    // Keep drafts and open explanations stable while the user interacts. Diff files stay open by design.
    if (data.stamp && (document.querySelector('dialog[open], #detail details[open]:not(.fd-keep)') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName))) return;
    data = next;
    // Opens on the task that waits for the user, when there is one.
    if (!data.issues.some(i => i.id === peek)) peek = null;
    if (!data.issues.some(i => i.id === selected)) selected = (data.issues.find(i => i.stage === 'ready' && !i.blocked) || data.issues.find(needsYou) || data.issues[0])?.id || null;
    $('updated').textContent = `Loaded ${new Date().toLocaleTimeString()} · usage may lag up to 60 s`;
    const skipped = data.skipped || [];
    notice(skipped.length ? `${skipped.length} task${skipped.length === 1 ? '' : 's'} could not be shown. ${skipped.map(s => `${s.id}: ${s.reason}`).join(' ')}` : '');
    render();
  };
  function refresh() {
    const script = document.createElement('script'); script.src = `board-data.js?t=${Date.now()}`;
    script.onload = () => script.remove();
    script.onerror = () => { script.remove(); lost = true; tick(); };
    document.body.appendChild(script);
  }
  setMode(mode);
  setInterval(tick, 5000);
  if (served) {
    // The server announces changes to task data; the slower poll also catches commits in the worktrees.
    setInterval(refresh, 10000);
    if (window.EventSource) new EventSource('/api/events').addEventListener('change', refresh);
  }
})();
