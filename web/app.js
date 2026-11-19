(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const number = (value, digits = 0) => Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
  const precise = (value) => number(value, 6);
  const compact = (value) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const labels = { input: 'Input · uncached', cacheWrite: 'Cache write', cacheRead: 'Cache read', output: 'Output' };
  const served = Boolean(window.__factoryToken);
  let data = { issues: [], projects: [] }, selected = null, tab = 'overview', view = 'work', scope = 'task', query = '', pending = null;
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
    const row = i => { const s = queueStatus(i); return `<button class="fd-row" data-task="${escape(i.id)}" aria-pressed="${i.id === selected}"><span class="fd-repo"><span>${escape(i.repo)}</span><span>${i.kind === 'review' ? 'PR ' : ''}#${escape(i.issue)}</span></span><strong>${escape(i.title)}</strong><span class="fd-status ${s.cls}">${escape(s.text)}</span><span class="fd-tokens">${i.tokens.availability === 'unavailable' ? 'Usage unavailable' : `${compact(i.tokens.fresh)} new tokens${i.tokens.availability === 'partial' ? ' · partial' : ''}`}</span></button>`; };
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
    const tabs = [['overview', 'Overview'], ['changes', 'Changes'], ['evidence', 'Evidence'], ['brief', 'Task brief'], ['usage', 'Usage']];
    if (i.kind === 'review') tabs.splice(1, 0, ['review', 'Review draft']);
    if (!tabs.some(([key]) => key === tab)) tab = 'overview';
    const s = queueStatus(i);
    $('detail').innerHTML = `<div class="fd-head"><button class="fd-btn fd-back" data-back>← All tasks</button><div class="fd-kicker">${externalLink(i.url, `${i.repo} / ${i.kind === 'review' ? 'PR ' : ''}#${i.issue}`)}<span class="${s.cls}">${escape(s.text)}</span>${i.tier ? `<span class="fd-muted">${escape(i.tier)} tier</span>` : ''}</div><h1>${escape(i.title)}</h1><div class="fd-branch">${escape(i.branch)} · ${escape((i.head || 'worktree missing').slice(0, 12))} · base ${escape(i.base)}</div>${progress(i)}</div><div class="fd-tabs" aria-label="Task sections">${tabs.map(([key, title]) => `<button data-tab="${key}" aria-pressed="${tab === key}">${title}</button>`).join('')}</div><div class="fd-body" id="body"></div><footer class="fd-footer"><div class="fd-actions">${served && i.approvalKey ? '<button class="fd-btn fd-primary" data-action="approve">Approve this version</button>' : ''}${served ? '<button class="fd-btn" data-action="archive">Archive task</button>' : ''}${i.prUrl ? externalLink(i.prUrl, 'Open pull request') : ''}</div><small>${i.approvalKey ? 'Approval covers the displayed commit and draft. It does not push, merge, or post.' : 'Checks and evidence stay tied to their recorded commit.'}</small></footer>`;
    if (tab === 'usage') renderUsage(i);
    else if (tab === 'overview') renderOverview(i);
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
    $('body').innerHTML = `<section class="fd-next"><h3>What happens next</h3>${next}</section>${i.criteria.length ? `<section><h3>Acceptance criteria</h3><ul>${i.criteria.map(x => `<li>${escape(x)}</li>`).join('')}</ul><p class="fd-caption">From the plan. The verifier report says how each was checked; read it under Evidence.</p></section>` : ''}<section><h3>Checks at the current commit</h3>${i.tampered.length ? `<p class="fd-fail">Evidence integrity problem: ${escape(i.tampered.join('; '))}</p>` : ''}${checksTable(i)}</section><section><h3>Changes</h3><p>${c ? `${number(c.files)} file${c.files === 1 ? '' : 's'} changed · <span class="fd-pass">+${number(c.additions)}</span> <span class="fd-fail">−${number(c.deletions)}</span> lines against the merge base` : 'Change size unavailable: the worktree is missing.'}</p><button class="fd-btn" data-tab="changes">Read the changes</button></section>${draft ? doc(i.kind === 'review' ? 'Review draft this approval covers' : 'PR description this approval covers', draft) : ''}`;
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
    $('projects').innerHTML = '<h1>Projects</h1><p class="fd-desc">Each project supplies its own verification commands. Configuration stays on this machine.</p>' + data.projects.map(p => `<div class="fd-project"><h3>${escape(p.key)}</h3><p>${externalLink(`https://github.com/${p.remote}`, p.remote)} · base ${escape(p.baseBranch)}</p><p><code>${escape(p.dir)}</code></p>${p.gates.length ? p.gates.map(g => `<p>${escape(g.name)}: <code>${escape(g.cmd)}</code></p>`).join('') : '<p class="fd-warning">No verification gates configured.</p>'}</div>`).join('') + '<h3 style="margin-top:24px">Register another project</h3><pre>factory add app /path/to/app --verify "npm run verify"</pre><p class="fd-caption">Edit repos.json in your factory data directory to change commands, branch conventions, or project rules.</p>';
  }
  function renderActivity() {
    const events = data.issues.flatMap(i => i.history.map(h => ({ ...h, id: i.id }))).sort((a, b) => b.at.localeCompare(a.at));
    $('activity').innerHTML = '<h1>Activity</h1><p class="fd-desc">Recorded stage history for tasks currently in flight.</p>' + events.map(h => `<div class="fd-project"><p>${escape(h.id)} · <strong>${escape(h.stage)}</strong></p><p>${escape(h.note)}</p><span class="fd-caption">${escape(h.at)}</span></div>`).join('');
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
  function render() { renderQueue(); renderDetail(); renderProjects(); renderActivity(); renderMetrics(); }
  const views = ['work', 'projects', 'activity', 'metrics'];
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {
    view = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b === button));
    views.forEach(id => { $(id).hidden = id !== view; });
    $('view-title').textContent = button.textContent;
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
  $('detail').addEventListener('toggle', e => { if (e.target.open && e.target.dataset?.log) loadLog(e.target); }, true);
  $('detail').onclick = e => {
    if (e.target.closest('[data-back]')) { showPane('list'); document.querySelector(`[data-task="${CSS.escape(selected)}"]`)?.focus(); return; }
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
  $('new-task').onclick = () => {
    $('new-project').innerHTML = data.projects.map(p => `<option value="${escape(p.key)}">${escape(p.key)}</option>`).join('');
    newCommand(); $('new-dialog').showModal();
  };
  ['new-project', 'new-kind', 'new-number'].forEach(id => $(id).oninput = newCommand);
  $('copy-command').onclick = async () => {
    try { await navigator.clipboard.writeText($('new-command').textContent); notice('Task command copied. Run it in your terminal.'); }
    catch { notice('Clipboard unavailable. Select and copy the command shown in the dialog.'); }
  };
  window.__factoryData = next => {
    $('connection').textContent = served ? 'Connected · local server' : 'Static snapshot';
    if (next.stamp === data.stamp) return;
    // Keep drafts and open explanations stable while the user interacts. Diff files stay open by design.
    if (data.stamp && (document.querySelector('dialog[open], #detail details[open]:not(.fd-keep)') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName))) return;
    data = next;
    // Opens on the task that waits for the user, when there is one.
    if (!data.issues.some(i => i.id === selected)) selected = (data.issues.find(i => i.stage === 'ready' && !i.blocked) || data.issues.find(needsYou) || data.issues[0])?.id || null;
    $('updated').textContent = `Loaded ${new Date().toLocaleTimeString()} · usage may lag up to 60 s`;
    render();
  };
  function refresh() {
    const script = document.createElement('script'); script.src = `board-data.js?t=${Date.now()}`;
    script.onload = () => script.remove();
    script.onerror = () => { script.remove(); $('connection').textContent = 'Disconnected · showing last loaded data'; };
    document.body.appendChild(script);
  }
  if (served) setInterval(refresh, 10000);
})();
