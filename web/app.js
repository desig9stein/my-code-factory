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
  let report = null, reportDay = '', reportPlain = '', reportBusy = false;
  let setup = null, editing = null, gh = null, ghError = '', ghLoading = false, ghRepo = '', ghQuery = '', projectQuery = '';
  let ghFilter = { who: 'assigned', login: '', state: 'open', label: '' };
  // Mirrors the WHO modes in lib/github.mjs.
  const WHO = [['assigned', 'Assigned to me'], ['created', 'Created by me'], ['mentioned', 'Mentioning me'], ['involved', 'Involving me'], ['user', 'Assigned to a GitHub user'], ['anyone', 'Anyone']];
  try {
    const saved = JSON.parse(localStorage.getItem('factory-scenario-v1'));
    if (saved) { rates = validateAssumptions(saved.rates); if (OBJECTS[saved.object]) object = saved.object; }
  } catch { /* Invalid or unavailable storage uses explicit defaults. */ }
  const task = () => data.issues.find(i => i.id === selected);
  const status = (i) => i.blocked ? 'Blocked' : i.stage === 'ready' ? 'Waiting for your review' : (i.stageTitle || i.stage).replaceAll('-', ' ');
  const notice = (message) => { $('notice').textContent = message; };
  const externalLink = (url, label) => /^https:\/\/github\.com\//i.test(url || '') ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>` : escape(label);
  async function post(pathname, body) {
    const response = await fetch(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Factory-Token': window.__factoryToken }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Action failed.');
    return result;
  }
  function show(next) {
    view = next;
    document.querySelectorAll('[data-view]').forEach(b => { b.setAttribute('aria-pressed', b.dataset.view === view); if (b.dataset.view === view) $('view-title').textContent = b.textContent; });
    ['work', 'github', 'report', 'projects', 'workflow', 'activity'].forEach(id => { $(id).hidden = id !== view; });
    if (view === 'projects') loadSetup();
    if (view === 'workflow') workflow.open();
    if (view === 'report' && !report) loadReport();
    if (view === 'github' && !gh && !ghLoading) loadGithub();
  }
  function checklist() {
    if (!served) return '';
    if (!setup) return '<p class="fd-caption">Checking setup…</p>';
    const row = (ok, text, fix) => `<li><span class="${ok ? 'fd-pass' : 'fd-warning'}">${ok ? '✓' : '!'}</span> ${escape(text)}${ok || !fix ? '' : `<br><span class="fd-caption">${escape(fix)}</span>`}</li>`;
    const bare = data.projects.filter(p => !p.gates.length).map(p => p.key);
    const rows = [...setup.checks.map(c => [c.ok, c.name, c.fix]),
      [data.projects.length > 0, `${data.projects.length} project(s) registered`, 'Register one on the Projects page, or run "factory setup" in your terminal.'],
      [!bare.length, bare.length ? `No verification gate: ${bare.join(', ')}` : 'Every project has a verification gate', 'Open Projects and use Edit to add one.'],
      [setup.hooksInstalled, 'Claude Code guard hooks', 'Optional. Run "factory hooks --install" in your terminal.']];
    const open = rows.filter(([ok]) => !ok).length;
    return `<details class="fd-setup" ${open ? 'open' : ''}><summary>Setup · ${open ? `${open} item(s) to look at` : 'all checks pass'}</summary><ul class="fd-checks">${rows.map(r => row(...r)).join('')}</ul><p class="fd-caption">Workspace <code>${escape(setup.workspace)}</code> · data <code>${escape(setup.root)}</code></p></details>`;
  }
  async function loadSetup() {
    if (!served) return;
    try {
      const response = await fetch('/api/setup');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not read the setup state.');
      setup = result;
    } catch (error) { notice(error.message); return; }
    if (document.querySelector('dialog[open]')) return;
    renderProjects();
    if (!task()) renderDetail();
  }
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
      $('detail').innerHTML = `<div class="fd-empty"><h1>Your workspace is ready.</h1>${data.projects.length ? '<p>No task is in flight. Pick an issue under GitHub issues, or use New task with an issue or pull request number. Its progress, evidence, and usage will appear here.</p>' : '<p>No project is registered yet. This command checks your tools and registers every GitHub repository in your workspace:</p><pre>factory setup</pre><p>You can also register them one by one on the Projects page.</p>'}${checklist()}</div>`;
      return;
    }
    const tabs = [['changes', 'Changes'], ['evidence', 'Evidence'], ['brief', 'Task brief'], ['usage', 'Usage']];
    if (i.kind === 'review') tabs.splice(1, 0, ['review', 'Review draft']);
    if (!tabs.some(([key]) => key === tab)) tab = 'usage';
    $('detail').innerHTML = `<div class="fd-head"><div class="fd-kicker">${externalLink(i.url, `${i.repo} / ${i.kind === 'review' ? 'PR ' : ''}#${i.issue}`)}<span>${escape(status(i))}</span></div><h1>${escape(i.title)}</h1>${i.blocked ? `<p class="fd-warning">${escape(i.blocked)}</p>` : ''}<div class="fd-branch">${escape(i.branch)} · ${(i.head || 'worktree missing').slice(0, 12)} · base ${escape(i.base)}</div><button class="fd-usage-strip" data-tab="usage">${i.tokens.availability === 'unavailable' ? 'Usage unavailable · link a supported session' : `${number(i.tokens.fresh)} new tokens · ${number(i.tokens.cacheRead)} cache-read tokens · ${i.tokens.sessions} linked session(s)`}</button></div><div class="fd-tabs" aria-label="Task sections">${tabs.map(([key, title]) => `<button data-tab="${key}" aria-pressed="${tab === key}">${title}</button>`).join('')}</div><div class="fd-body" id="body"></div><footer class="fd-footer"><div class="fd-actions">${served && i.approvalKey ? '<button class="fd-btn fd-primary" data-action="approve">Approve this version</button><button class="fd-btn" data-action="reject">Send back</button>' : ''}${served ? '<button class="fd-btn" data-action="archive">Archive task</button>' : ''}${i.prUrl ? externalLink(i.prUrl, 'Open pull request') : ''}</div><small>${i.approvalKey ? 'Approval covers the displayed commit and draft. It does not push, merge, or post.' : 'Checks and evidence stay tied to their recorded commit.'}</small></footer>`;
    if (tab === 'usage') renderUsage(i);
    else if (tab === 'brief') $('body').innerHTML = doc('Next step for the agent', i.brief) + doc('Issue or pull request', i.docs.issue || i.docs.pr) + doc('Triage', i.docs.triage) + doc('Open questions', i.docs.questions) + doc('Plan', i.docs.plan) + doc('PR description', i.docs.prBody);
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
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  function ago(iso) {
    const days = (Date.now() - Date.parse(iso)) / 864e5;
    if (!Number.isFinite(days)) return '';
    return days < 1 ? 'today' : days < 2 ? 'yesterday' : days < 30 ? `${Math.floor(days)}d ago` : days < 365 ? `${Math.floor(days / 30)}mo ago` : `${Math.floor(days / 365)}y ago`;
  }
  function projectCard(p, footer, kind = '') {
    const gates = p.gates.length ? `<ul class="fd-gate-list">${p.gates.map(g => `<li><span class="fd-chip">${escape(g.name)}</span><code title="${escape(g.cmd)}">${escape(g.cmd)}</code></li>`).join('')}</ul>` : '<p><span class="fd-badge fd-badge-warn">No verification gate</span></p>';
    return `<article class="fd-card ${kind}"><header><h3>${escape(p.key)}</h3><span class="fd-badge" title="Base branch">${escape(p.baseBranch)}</span></header><div><p class="fd-card-remote">${externalLink(`https://github.com/${p.remote}`, p.remote)}</p>${gates}${p.install ? `<p class="fd-card-install"><span>install</span><code title="${escape(p.install)}">${escape(p.install)}</code></p>` : ''}</div>${footer ? `<footer>${footer}</footer>` : ''}</article>`;
  }
  function renderProjectCards() {
    const match = p => `${p.key} ${p.remote}`.toLowerCase().includes(projectQuery.toLowerCase());
    const registered = data.projects.filter(match).sort((a, b) => a.key.localeCompare(b.key));
    const found = served && setup ? setup.candidates.map((c, n) => [c, n]).filter(([c]) => match(c)) : [];
    const actions = p => served ? `<button class="fd-btn" data-edit="${escape(p.key)}">Edit</button><button class="fd-btn fd-ghost" data-remove="${escape(p.key)}">Remove</button>` : '';
    $('project-cards').innerHTML = (registered.length ? `<div class="fd-cards">${registered.map(p => projectCard(p, actions(p))).join('')}</div>` : `<p class="fd-blank">${data.projects.length ? 'No project matches this filter.' : 'No project is registered yet.'}</p>`)
      + (served && setup?.pending?.length ? `<h2 class="fd-section">From your team's setup, not on this machine yet <span>${setup.pending.length}</span></h2><p class="fd-caption">These projects came with an imported setup, but their repository was not found in your workspace. Their shared commands and workflow are kept and apply when you add the project. Clone it into the workspace, or if it is already cloned somewhere else, use "Add a project by its folder" below.</p><ul class="fd-asset-list fd-pending">${setup.pending.map(p => `<li><span class="fd-chip">${escape(p.key)}</span>${externalLink(`https://github.com/${p.remote}`, p.remote)}<code>git clone git@github.com:${escape(p.remote)}.git</code></li>`).join('')}</ul>` : '')
      + (found.length ? `<h2 class="fd-section">Found in your workspace <span>${found.length}</span></h2><p class="fd-caption">GitHub repositories directly inside the workspace that are not registered. Review the suggested commands before you register one.</p><div class="fd-cards">${found.map(([c, n]) => projectCard(c, `<button class="fd-btn fd-primary" data-register="${n}">Register</button>`, 'fd-card-new')).join('')}</div>` : '');
  }
  function renderProjects() {
    const bare = data.projects.filter(p => !p.gates.length).length;
    const stats = `<span class="fd-stat"><b>${data.projects.length}</b> registered</span>${bare ? `<span class="fd-stat fd-stat-warn"><b>${bare}</b> without a gate</span>` : ''}${served && setup?.candidates.length ? `<span class="fd-stat"><b>${setup.candidates.length}</b> not registered</span>` : ''}`;
    $('projects').innerHTML = `<header class="fd-page-head"><div><h1>Projects</h1><p class="fd-desc">Each project supplies its own verification commands. Configuration stays on this machine.</p></div><div class="fd-stats">${stats}${served ? '<button class="fd-btn" type="button" id="export-config" title="Projects, gates and workflow in one file, without paths or task data">Export for the team</button>' : ''}</div></header>${checklist()}<div class="fd-bar"><label class="fd-search"><span class="sr-only">Filter projects</span><input id="project-search" type="search" placeholder="Filter by name or repository" value="${escape(projectQuery)}"></label></div><div id="project-cards"></div>${served ? `<h2 class="fd-section">Add a project by its folder</h2><p class="fd-caption">For a repository that is not inside the workspace${data.workspace ? ` (${escape(data.workspace)})` : ''}, or one the list above did not find. It needs to be cloned on this machine and have a GitHub origin.</p><form id="locate-form" class="fd-locate"><label><span class="sr-only">Folder of the repository</span><input name="path" required placeholder="~/code/my-app" autocomplete="off" spellcheck="false"></label><button class="fd-btn" type="submit">Find it</button></form><p id="locate-error" class="fd-failed" role="alert"></p>` : ''}<p class="fd-caption fd-page-foot">Branch conventions and other project rules live in repos.json in your factory data directory.</p>`;
    renderProjectCards();
  }
  $('projects').addEventListener('submit', async e => {
    if (e.target.id !== 'locate-form') return;
    e.preventDefault();
    $('locate-error').textContent = '';
    try { openProject('add', await post('/api/project/locate', { path: e.target.elements.path.value })); }
    catch (error) { $('locate-error').textContent = error.message; }
  });
  $('projects').addEventListener('input', e => { if (e.target.id === 'project-search') { projectQuery = e.target.value; renderProjectCards(); } });
  const dayOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  async function loadReport(day = reportDay || dayOf(new Date())) {
    reportDay = day; reportPlain = ''; report = null; renderReport();
    if (!served) return;
    try {
      const response = await fetch(`/api/report?day=${encodeURIComponent(day)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not build the report.');
      if (day === reportDay) report = result;
    } catch (error) { report = { error: error.message }; }
    renderReport();
  }
  function renderReport() {
    const head = '<div><h1>Daily report</h1><p class="fd-desc">What was recorded for one day: factory tasks, your commits and your pull requests in the registered projects.</p></div>';
    if (!served) { $('report').innerHTML = `<header class="fd-page-head">${head}</header><p class="fd-blank">This view needs the local server. Run <code>factory board</code>.</p>`; return; }
    const today = dayOf(new Date());
    const controls = `<div class="fd-actions"><button class="fd-btn" type="button" data-report-shift="-1" aria-label="Previous day">←</button><input id="report-day" type="date" aria-label="Day" value="${escape(reportDay)}" max="${today}"><button class="fd-btn" type="button" data-report-shift="1" aria-label="Next day" ${reportDay >= today ? 'disabled' : ''}>→</button><button class="fd-btn" type="button" data-report-day="${today}" ${reportDay === today ? 'disabled' : ''}>Today</button></div>`;
    let body = '<p class="fd-blank">Collecting the day…</p>';
    if (report?.error) body = `<p class="fd-blank fd-failed" role="alert">${escape(report.error)}</p>`;
    else if (report) {
      const tasks = report.tasks.length ? `<h2 class="fd-section">Tasks <span>${report.tasks.length}</span></h2><ul class="fd-issues">${report.tasks.map(t => `<li class="fd-issue"><div><p class="fd-issue-title">${externalLink(t.url, t.title)}</p><p class="fd-issue-meta"><span class="fd-chip">${escape(t.project)}</span><span>${t.kind === 'review' ? 'PR ' : ''}#${escape(t.number)}</span>${t.milestones.map(m => `<span class="fd-badge fd-badge-ok">${escape(m)}</span>`).join('')}<span>${t.from && t.from !== t.to ? `${escape(t.from)} → ${escape(t.to)}` : `at ${escape(t.to)}`}</span>${t.checks.passed + t.checks.failed ? `<span>${t.checks.passed} checks passed, ${t.checks.failed} failed</span>` : ''}${t.prUrl ? externalLink(t.prUrl, 'pull request') : ''}</p></div></li>`).join('')}</ul>` : '';
      const prs = [...report.pullRequests.opened.map(p => ['opened', p]), ...report.pullRequests.merged.map(p => ['merged', p])];
      const pulls = prs.length ? `<h2 class="fd-section">Pull requests <span>${prs.length}</span></h2><ul class="fd-issues">${prs.map(([what, p]) => `<li class="fd-issue"><div><p class="fd-issue-title">${externalLink(p.url, p.title)}</p><p class="fd-issue-meta"><span class="fd-badge fd-badge-ok">${what}</span><span>${escape(p.repo)}#${escape(p.number)}</span></p></div></li>`).join('')}</ul>` : '';
      const commits = report.commits.length ? `<h2 class="fd-section">Commits <span>${report.commits.reduce((n, c) => n + c.count, 0)}</span></h2>${report.commits.map(c => `<details class="fd-panel fd-general"><summary>${escape(c.project)} · ${c.count}</summary><ul class="fd-asset-list">${c.commits.map(x => `<li><code>${escape(x.sha)}</code><span>${escape(x.subject)}</span></li>`).join('')}</ul></details>`).join('')}` : '';
      body = `<div class="fd-wf-grid"><section class="fd-panel"><div class="fd-editor-head"><h3>Summary from the records</h3><button class="fd-btn" type="button" data-copy="report-summary">Copy</button></div><pre id="report-summary" class="fd-report">${escape(report.summary)}</pre></section><section class="fd-panel"><div class="fd-editor-head"><h3>In plain English</h3>${reportPlain ? '<button class="fd-btn" type="button" data-copy="report-plain">Copy</button>' : ''}</div>${reportPlain ? `<pre id="report-plain" class="fd-report">${escape(reportPlain)}</pre><p class="fd-caption">Written by Claude from the summary on the left. Check it against the records before you send it.</p><button class="fd-btn" type="button" id="report-write" ${reportBusy ? 'disabled' : ''}>${reportBusy ? 'Writing…' : 'Write it again'}</button>` : `<p class="fd-caption" style="margin-top:12px">Claude Code on this machine can rewrite the summary as a few short sentences for someone who does not read commit messages. It receives only the summary text on the left and has no tools. It takes up to a minute.</p><button class="fd-btn fd-primary" type="button" id="report-write" ${reportBusy ? 'disabled' : ''}>${reportBusy ? 'Writing…' : 'Write it in plain English'}</button>`}<p id="report-error" class="fd-failed" role="alert"></p></section></div>${tasks}${pulls}${commits}${report.pullRequests.error ? `<p class="fd-caption fd-page-foot">${escape(report.pullRequests.error)}</p>` : ''}`;
    }
    $('report').innerHTML = `<header class="fd-page-head">${head}${controls}</header>${body}`;
  }
  $('report').addEventListener('change', e => { if (e.target.id === 'report-day' && e.target.value) loadReport(e.target.value); });
  $('report').addEventListener('click', async e => {
    const shift = e.target.closest('[data-report-shift]'), copy = e.target.closest('[data-copy]');
    if (shift) { const d = new Date(`${reportDay}T12:00:00`); d.setDate(d.getDate() + Number(shift.dataset.reportShift)); loadReport(dayOf(d)); }
    if (e.target.dataset.reportDay) loadReport(e.target.dataset.reportDay);
    if (copy) {
      try { await navigator.clipboard.writeText($(copy.dataset.copy).textContent); notice('Report copied.'); }
      catch { notice('Clipboard unavailable. Select the text and copy it.'); }
    }
    if (e.target.id === 'report-write' && !reportBusy) {
      const day = reportDay;
      reportBusy = true; renderReport();
      try { const result = await post('/api/report/write', { day }); if (day === reportDay) reportPlain = result.text; reportBusy = false; renderReport(); }
      catch (error) { reportBusy = false; renderReport(); if ($('report-error')) $('report-error').textContent = error.message; }
    }
  });
  const gateRow = (g = {}) => `<div class="fd-gate" data-cwd="${escape(g.cwd || '')}"><label>Name<input data-gate="name" required value="${escape(g.name || '')}" placeholder="verify"></label><label>Command<input data-gate="cmd" required value="${escape(g.cmd || '')}" placeholder="npm run verify"></label><button type="button" class="fd-btn" data-drop-gate>Remove</button></div>`;
  function openProject(mode, p) {
    editing = { mode, key: p.key, dir: p.dir, baseBranch: p.baseBranch, install: p.install || '' };
    const form = $('project-form');
    $('project-title').textContent = mode === 'edit' ? `Edit ${p.key}` : `Register ${p.key}`;
    $('project-dir').textContent = p.shared ? `${p.dir} · filled in from your team's shared setup for this repository` : p.dir;
    form.elements.key.value = p.key; form.elements.key.readOnly = mode === 'edit';
    form.elements.baseBranch.value = p.baseBranch; form.elements.install.value = p.install || '';
    $('project-gates').innerHTML = p.gates.map(gateRow).join('');
    $('project-error').textContent = '';
    $('project-dialog').showModal();
  }
  $('add-gate').onclick = () => { $('project-gates').insertAdjacentHTML('beforeend', gateRow()); $('project-gates').lastElementChild.querySelector('input').focus(); };
  $('project-gates').onclick = e => { if (e.target.closest('[data-drop-gate]')) e.target.closest('.fd-gate').remove(); };
  $('cancel-project').onclick = () => $('project-dialog').close();
  $('project-form').onsubmit = async e => {
    e.preventDefault();
    const form = e.target, base = form.elements.baseBranch.value.trim(), install = form.elements.install.value.trim();
    const gates = [...$('project-gates').querySelectorAll('.fd-gate')].map(row => ({ name: row.querySelector('[data-gate=name]').value.trim(), cmd: row.querySelector('[data-gate=cmd]').value.trim(), ...(row.dataset.cwd ? { cwd: row.dataset.cwd } : {}) }));
    $('save-project').disabled = true;
    try {
      if (editing.mode === 'edit') await post('/api/project/update', { key: editing.key, gates, ...(base !== editing.baseBranch ? { baseBranch: base } : {}), ...(install !== editing.install ? { install } : {}) });
      else await post('/api/project/add', { key: form.elements.key.value.trim(), dir: editing.dir, baseBranch: base, install, gates });
      notice(`${form.elements.key.value.trim()}: ${editing.mode === 'edit' ? 'saved' : 'registered'}.`);
      $('project-dialog').close(); gh = null; refresh(); loadSetup();
    } catch (error) { $('project-error').textContent = error.message; }
    finally { $('save-project').disabled = false; }
  };
  async function exportConfig() {
    try {
      const response = await fetch('/api/export');
      if (!response.ok) throw new Error((await response.json()).error || 'Export failed.');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([await response.text()], { type: 'application/json' }));
      link.download = 'factory.config.json';
      link.click();
      URL.revokeObjectURL(link.href);
      notice('Saved factory.config.json. A teammate applies it with: factory setup --workspace <directory> --from factory.config.json');
    } catch (error) { notice(error.message); }
  }
  $('projects').onclick = e => {
    if (e.target.id === 'export-config') exportConfig();
    const edit = e.target.closest('[data-edit]'), remove = e.target.closest('[data-remove]'), register = e.target.closest('[data-register]');
    if (edit) openProject('edit', data.projects.find(p => p.key === edit.dataset.edit));
    if (register) openProject('add', setup.candidates[Number(register.dataset.register)]);
    if (remove) {
      const key = remove.dataset.remove;
      pending = { path: '/api/project/remove', body: { key }, done: `${key}: removed from the registry.` };
      $('action-title').textContent = 'Remove this project?';
      $('action-text').textContent = `${key}: this removes the project from the factory registry. The repository folder, its branches and recorded task history are kept. A project with tasks in flight is refused.`;
      $('action-dialog').showModal();
    }
  };
  async function loadGithub(fresh) {
    if (!served) return renderGithub();
    ghLoading = true;
    if ($('gh-results')) renderGithubList(); else renderGithub();
    try {
      const response = await fetch(`/api/github/issues${fresh ? '?fresh=1' : ''}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load GitHub issues.');
      const changed = JSON.stringify(result.filter) !== JSON.stringify(ghFilter);
      gh = result; ghFilter = result.filter; ghError = '';
      if (changed) $('github').innerHTML = '';
    } catch (error) { ghError = error.message; }
    ghLoading = false;
    if ($('gh-results')) renderGithubList(); else renderGithub();
  }
  function renderGithubList() {
    const all = gh?.issues || [];
    if (ghRepo && !all.some(i => i.project === ghRepo)) ghRepo = '';
    $('gh-loaded').textContent = ghLoading ? 'Loading…' : gh && !ghError ? `Loaded ${new Date(gh.loadedAt).toLocaleTimeString()}` : '';
    if (ghError) { $('gh-results').innerHTML = `<p class="fd-blank fd-failed" role="alert">${escape(ghError)}</p>`; return; }
    if (!gh) { $('gh-results').innerHTML = '<p class="fd-blank">Loading issues from GitHub…</p>'; return; }
    if (!data.projects.length) { $('gh-results').innerHTML = '<p class="fd-blank">No project is registered yet. Register one on the Projects page first.</p>'; return; }
    const counts = new Map();
    for (const i of all) counts.set(i.project, (counts.get(i.project) || 0) + 1);
    const chip = (key, label, count) => `<button type="button" class="fd-chip-btn" data-gh-repo="${escape(key)}" aria-pressed="${ghRepo === key}">${escape(label)} <b>${count}</b></button>`;
    const chips = `<div class="fd-chips" role="group" aria-label="Filter by project">${chip('', 'All projects', all.length)}${[...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([key, count]) => chip(key, key, count)).join('')}</div>`;
    const shown = all.filter(i => (!ghRepo || i.project === ghRepo) && `${i.title} #${i.number} ${i.labels.join(' ')}`.toLowerCase().includes(ghQuery.toLowerCase()));
    const row = i => `<li class="fd-issue"><div><p class="fd-issue-title">${externalLink(i.url, i.title)}</p><p class="fd-issue-meta"><span class="fd-chip">${escape(i.project)}</span><span>#${escape(i.number)}</span><span title="${escape(i.updatedAt)}">updated ${escape(ago(i.updatedAt))}</span>${i.assignees.length ? `<span>${escape(i.assignees.join(', '))}</span>` : ''}${i.labels.map(l => `<span class="fd-label">${escape(l.replace(/:[a-z0-9_+-]+:\s*/g, '') || l)}</span>`).join('')}</p></div><div class="fd-issue-action">${i.task ? `<span class="fd-badge fd-badge-ok">${escape(i.task.stage)}</span><button class="fd-btn" data-open-task="${escape(i.task.id)}">Open task</button>` : `<button class="fd-btn" data-start-project="${escape(i.project)}" data-start-number="${escape(i.number)}">Start task</button>`}</div></li>`;
    $('gh-results').innerHTML = chips + (shown.length ? `<ul class="fd-issues">${shown.map(row).join('')}</ul>` : `<p class="fd-blank">${all.length ? 'No loaded issue matches.' : 'No issues match this filter.'}</p>`)
      + `<p class="fd-caption fd-page-foot">${plural(shown.length, 'issue')} shown of ${all.length}.${all.length >= gh.limit ? ` GitHub returned the ${gh.limit} most recently updated; narrow the filter to see the rest.` : ''}</p>`;
  }
  function renderGithub() {
    const head = '<div><h1>GitHub issues</h1><p class="fd-desc">Issues in your registered projects, read through the GitHub CLI on this machine.</p></div>';
    if (!served) { $('github').innerHTML = `<header class="fd-page-head">${head}</header><p class="fd-blank">This view needs the local server. Run <code>factory board</code>.</p>`; return; }
    const f = ghFilter;
    const option = (value, label, current) => `<option value="${escape(value)}" ${value === current ? 'selected' : ''}>${escape(label)}</option>`;
    const state = (value, label) => `<label><input type="radio" name="state" value="${value}" ${f.state === value ? 'checked' : ''}><span>${label}</span></label>`;
    $('github').innerHTML = `<header class="fd-page-head">${head}<div class="fd-actions"><span class="fd-caption" id="gh-loaded" role="status"></span><button class="fd-btn" type="button" id="gh-refresh">Refresh</button></div></header><form id="gh-filter" class="fd-panel fd-filter"><label>Show issues<select name="who">${WHO.map(([value, label]) => option(value, label, f.who)).join('')}</select></label><label id="gh-login" ${f.who === 'user' ? '' : 'hidden'}>GitHub login<input name="login" value="${escape(f.login)}" placeholder="octocat"></label><fieldset class="fd-seg"><legend>State</legend><div>${state('open', 'Open')}${state('closed', 'Closed')}</div></fieldset><label>Label<input name="label" value="${escape(f.label)}" placeholder="Any label"></label><button class="fd-btn fd-primary" type="submit">Apply</button><p class="fd-caption">Saved in your factory data directory. It applies until you change it.</p></form><div class="fd-bar"><label class="fd-search"><span class="sr-only">Search loaded issues</span><input id="gh-search" type="search" placeholder="Search loaded issues by title, number or label" value="${escape(ghQuery)}"></label></div><div id="gh-results"></div>`;
    renderGithubList();
  }
  $('github').addEventListener('input', e => { if (e.target.id === 'gh-search') { ghQuery = e.target.value; renderGithubList(); } });
  $('github').addEventListener('change', e => {
    if (e.target.name === 'who') $('gh-login').hidden = e.target.value !== 'user';
  });
  $('github').addEventListener('submit', async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      ghFilter = (await post('/api/github/filter', { who: form.get('who'), login: form.get('login'), state: form.get('state'), label: form.get('label') })).filter;
      gh = null; ghError = ''; loadGithub();
    } catch (error) { ghError = error.message; renderGithub(); }
  });
  $('github').addEventListener('click', e => {
    if (e.target.id === 'gh-refresh') loadGithub(true);
    const chip = e.target.closest('[data-gh-repo]');
    if (chip) { ghRepo = chip.dataset.ghRepo; renderGithubList(); $('gh-results').querySelector('[aria-pressed=true]')?.focus(); }
    const open = e.target.closest('[data-open-task]'), start = e.target.closest('[data-start-project]');
    if (open) { selected = open.dataset.openTask; scope = 'task'; show('work'); renderQueue(); renderDetail(); }
    if (start) openNew(start.dataset.startProject, start.dataset.startNumber);
  });
  function renderActivity() {
    const events = data.issues.flatMap(i => i.history.map(h => ({ ...h, id: i.id }))).sort((a, b) => b.at.localeCompare(a.at));
    $('activity').innerHTML = '<h1>Activity</h1><p class="fd-desc">Recorded stage history for tasks currently in flight.</p>' + events.map(h => `<div class="fd-project"><p>${escape(h.id)} · <strong>${escape(h.stage)}</strong></p><p>${escape(h.note)}</p><span class="fd-caption">${escape(h.at)}</span></div>`).join('');
  }
  function render() { renderQueue(); renderDetail(); renderProjects(); renderActivity(); }
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => show(button.dataset.view));
  $('search').oninput = e => { query = e.target.value; renderQueue(); };
  $('tasks').onclick = e => { const button = e.target.closest('[data-task]'); if (button) { selected = button.dataset.task; scope = 'task'; renderQueue(); renderDetail(); } };
  $('detail').onclick = e => {
    const button = e.target.closest('[data-tab]');
    if (button) { tab = button.dataset.tab; renderDetail(); }
    const action = e.target.closest('[data-action]');
    if (action?.dataset.action === 'reject') {
      const i = task();
      pending = { id: i.id, key: i.approvalKey };
      $('reject-form').reset(); $('reject-error').textContent = '';
      $('reject-text').textContent = `${i.id}: the task goes back to the ${i.kind === 'review' ? 'draft' : 'implement'} step. Its checks and your approval start again on the next version.`;
      $('reject-dialog').showModal();
    } else if (action) {
      const i = task(), approving = action.dataset.action === 'approve';
      pending = { path: `/api/${action.dataset.action}`, body: { id: i.id, key: i.approvalKey }, done: `${i.id}: ${approving ? 'approved' : 'archived'}.` };
      $('action-title').textContent = approving ? 'Approve this version?' : 'Archive this task?';
      $('action-text').textContent = approving ? `${i.id}: approval covers commit ${(i.head || '').slice(0, 12)} and the displayed draft. Read the draft and evidence before confirming. This does not push or merge.` : `${i.id}: this removes the clean worktree and hides the task. The local branch and recorded evidence are kept. Dirty worktrees are refused.`;
      $('action-dialog').showModal();
    }
  };
  $('cancel-reject').onclick = () => $('reject-dialog').close();
  $('reject-form').onsubmit = async e => {
    e.preventDefault();
    const form = e.target;
    $('confirm-reject').disabled = true;
    try {
      await post('/api/reject', { ...pending, reason: form.elements.reason.value, lesson: form.elements.lesson.value });
      notice(`${pending.id}: sent back.`);
      $('reject-dialog').close(); pending = null; refresh();
    } catch (error) { $('reject-error').textContent = error.message; }
    finally { $('confirm-reject').disabled = false; }
  };
  $('confirm-action').onclick = async () => {
    if (!pending) return;
    const request = { ...pending };
    $('confirm-action').disabled = true;
    try {
      await post(request.path, request.body);
      notice(request.done);
      $('action-dialog').close(); pending = null; gh = null; refresh(); loadSetup();
    } catch (error) { $('action-text').textContent = error.message; }
    finally { $('confirm-action').disabled = false; }
  };
  function newCommand() {
    const project = $('new-project').value, n = $('new-number').value;
    const valid = /^[1-9]\d*$/.test(n) && project;
    $('new-command').textContent = valid ? `factory ${$('new-kind').value} '${project}#${n}'` : 'Choose a project and enter a number.';
    $('copy-command').disabled = !valid;
  }
  function openNew(project, number) {
    $('new-project').innerHTML = data.projects.map(p => `<option value="${escape(p.key)}" ${p.key === project ? 'selected' : ''}>${escape(p.key)}</option>`).join('');
    if (number) { $('new-kind').value = 'new'; $('new-number').value = number; }
    newCommand(); $('new-dialog').showModal();
  }
  $('new-task').onclick = () => openNew();
  ['new-project', 'new-kind', 'new-number'].forEach(id => $(id).oninput = newCommand);
  $('copy-command').onclick = async () => {
    try { await navigator.clipboard.writeText($('new-command').textContent); notice('Task command copied. Run it in your terminal.'); }
    catch { notice('Clipboard unavailable. Select and copy the command shown in the dialog.'); }
  };
  window.__factoryData = next => {
    $('connection').textContent = served ? 'Connected · local server' : 'Static snapshot';
    if (next.workspace) $('workspace-note').textContent = `WORKSPACE ${next.workspace}`;
    if (next.stamp === data.stamp) return;
    // Keep drafts and open explanations stable while the user interacts.
    if (data.stamp && (document.querySelector('dialog[open], #detail details[open]:not(.fd-setup)') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName))) return;
    data = next;
    if (!data.issues.some(i => i.id === selected)) selected = data.issues[0]?.id || null;
    $('updated').textContent = `Loaded ${new Date().toLocaleTimeString()} · usage may lag up to 60 s`;
    render();
    if (view === 'github') { if (gh) loadGithub(); else renderGithub(); }
    if (view === 'workflow' && !workflow.busy()) workflow.open();
  };
  function refresh() {
    const script = document.createElement('script'); script.src = `board-data.js?t=${Date.now()}`;
    script.onload = () => script.remove();
    script.onerror = () => { script.remove(); $('connection').textContent = 'Disconnected · showing last loaded data'; };
    document.body.appendChild(script);
  }
  const workflow = mountWorkflow({ $, escape, post, served, notice, projects: () => data.projects });
  renderGithub();
  if (served) { setInterval(refresh, 10000); loadSetup(); }
})();
