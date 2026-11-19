(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const number = (value, digits = 0) => Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
  const precise = (value) => number(value, 6);
  const compact = (value) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const labels = { input: 'Input · uncached', cacheWrite: 'Cache write', cacheRead: 'Cache read', output: 'Output' };
  const served = Boolean(window.__factoryToken);
  let data = { issues: [], projects: [] }, selected = null, tab = 'usage', view = 'work', scope = 'task', query = '', pending = null;
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
  function renderQueue() {
    const items = [...data.issues].sort((a, b) => (b.blocked || b.stage === 'ready' ? 1 : 0) - (a.blocked || a.stage === 'ready' ? 1 : 0));
    const shown = items.filter(i => `${i.title} ${i.repo} ${i.id}`.toLowerCase().includes(query.toLowerCase()));
    $('task-count').textContent = data.issues.length;
    $('tasks').innerHTML = shown.map(i => `<button class="fd-row" data-task="${escape(i.id)}" aria-pressed="${i.id === selected}"><span class="fd-repo"><span>${escape(i.repo)}</span><span>${i.kind === 'review' ? 'PR ' : ''}#${escape(i.issue)}</span></span><strong>${escape(i.title)}</strong><span class="fd-status ${i.blocked ? 'fd-failed' : ''}">${escape(status(i))}</span><span class="fd-tokens">${i.tokens.availability === 'unavailable' ? 'Usage unavailable' : `${compact(i.tokens.fresh)} new tokens${i.tokens.availability === 'partial' ? ' · partial' : ''}`}</span></button>`).join('') || '<p class="fd-queue-note">No matching tasks.</p>';
  }
  function renderDetail() {
    const i = task();
    if (!i) {
      $('detail').innerHTML = '<div class="fd-empty"><h1>Your workspace is ready.</h1><p>Register a project, then bring in a GitHub issue or pull request. Its progress, evidence, and usage will appear here.</p><pre>factory add app /path/to/app --verify "npm run verify"\nfactory new app#42</pre><p class="fd-caption">Use Projects to see registered repositories.</p></div>';
      return;
    }
    const tabs = [['changes', 'Changes'], ['evidence', 'Evidence'], ['brief', 'Task brief'], ['usage', 'Usage']];
    if (i.kind === 'review') tabs.splice(1, 0, ['review', 'Review draft']);
    if (!tabs.some(([key]) => key === tab)) tab = 'usage';
    $('detail').innerHTML = `<div class="fd-head"><div class="fd-kicker">${externalLink(i.url, `${i.repo} / ${i.kind === 'review' ? 'PR ' : ''}#${i.issue}`)}<span>${escape(status(i))}</span></div><h1>${escape(i.title)}</h1>${i.blocked ? `<p class="fd-warning">${escape(i.blocked)}</p>` : ''}<div class="fd-branch">${escape(i.branch)} · ${(i.head || 'worktree missing').slice(0, 12)} · base ${escape(i.base)}</div><button class="fd-usage-strip" data-tab="usage">${i.tokens.availability === 'unavailable' ? 'Usage unavailable · link a supported session' : `${number(i.tokens.fresh)} new tokens · ${number(i.tokens.cacheRead)} cache-read tokens · ${i.tokens.sessions} linked session(s)`}</button></div><div class="fd-tabs" aria-label="Task sections">${tabs.map(([key, title]) => `<button data-tab="${key}" aria-pressed="${tab === key}">${title}</button>`).join('')}</div><div class="fd-body" id="body"></div><footer class="fd-footer"><div class="fd-actions">${served && i.approvalKey ? '<button class="fd-btn fd-primary" data-action="approve">Approve this version</button>' : ''}${served ? '<button class="fd-btn" data-action="archive">Archive task</button>' : ''}${i.prUrl ? externalLink(i.prUrl, 'Open pull request') : ''}</div><small>${i.approvalKey ? 'Approval covers the displayed commit and draft. It does not push, merge, or post.' : 'Checks and evidence stay tied to their recorded commit.'}</small></footer>`;
    if (tab === 'usage') renderUsage(i);
    else if (tab === 'brief') $('body').innerHTML = doc('Issue or pull request', i.docs.issue || i.docs.pr) + doc('Triage', i.docs.triage) + doc('Open questions', i.docs.questions) + doc('Plan', i.docs.plan) + doc('PR description', i.docs.prBody);
    else if (tab === 'review') $('body').innerHTML = doc('Review draft', i.docs.review);
    else if (tab === 'evidence') renderEvidence(i);
    else renderChanges(i);
  }
  function renderEvidence(i) {
    $('body').innerHTML = `<h3>Checks at the current commit</h3>${i.tampered.length ? `<p class="fd-failed">Evidence integrity problem: ${escape(i.tampered.join('; '))}</p>` : ''}<div class="fd-evidence">${i.gates.map(g => `<div><span>${escape(g.name)}</span><span class="${g.status === 'passed' ? 'fd-pass' : 'fd-warning'}">${escape(g.status)}${g.verifier ? ` / verifier: ${escape(g.verifier)}` : ''}</span></div>`).join('') || '<p>No gates configured for this project.</p>'}</div><p class="fd-caption">${i.regress ? `Regression: ${escape(i.regress)}. ` : ''}Verifier verdict: ${escape(i.verdict || 'not recorded')}.</p><h3 style="margin-top:24px">Recorded runs</h3>${[...i.evidence].reverse().map(r => `<details><summary>${escape(r.name)} · ${r.stale || r.dirty ? 'STALE' : r.ok ? 'PASS' : 'FAIL'} · ${escape(r.actor)} · ${escape((r.sha || '').slice(0, 8))}</summary><p class="fd-caption">${escape(r.startedAt)}${r.durationMs !== null ? ` · ${number(r.durationMs / 1000, 1)} seconds` : ''}</p>${r.cmd ? `<pre>${escape(r.cmd)}</pre>` : ''}${r.text ? `<pre>${escape(r.text)}</pre>` : ''}${r.log ? `<a href="${escape(r.log)}" target="_blank" rel="noopener noreferrer">Open recorded log</a>` : ''}</details>`).join('')}${doc('Verifier report', i.docs.verify)}`;
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
      $('body').innerHTML = '<p class="fd-caption">Committed changes against the merge base. Uncommitted edits are excluded.</p>' + `<pre>${escape(result.diff || 'No committed changes.')}</pre>`;
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
  function render() { renderQueue(); renderDetail(); renderProjects(); renderActivity(); }
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {
    view = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b === button));
    ['work', 'projects', 'activity'].forEach(id => { $(id).hidden = id !== view; });
    $('view-title').textContent = button.textContent;
  });
  $('search').oninput = e => { query = e.target.value; renderQueue(); };
  $('tasks').onclick = e => { const button = e.target.closest('[data-task]'); if (button) { selected = button.dataset.task; scope = 'task'; renderQueue(); renderDetail(); } };
  $('detail').onclick = e => {
    const button = e.target.closest('[data-tab]');
    if (button) { tab = button.dataset.tab; renderDetail(); }
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
    // Keep drafts and open explanations stable while the user interacts.
    if (data.stamp && (document.querySelector('dialog[open], #detail details[open]') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName))) return;
    data = next;
    if (!data.issues.some(i => i.id === selected)) selected = data.issues[0]?.id || null;
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
