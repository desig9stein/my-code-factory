(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const number = (value, digits = 0) => Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
  const precise = (value) => number(value, 6);
  const compact = (value) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const labels = { input: 'Input · uncached', cacheWrite: 'Cache write', cacheRead: 'Cache read', output: 'Output' };
  const served = Boolean(window.__factoryToken);
  let data = { issues: [], projects: [] }, peek = null, lost = false, selected = null, tab = '', shownTab = 'details', view = 'work', scope = 'task', query = '', pending = null;
  let rates = { ...DEFAULT_ASSUMPTIONS }, object = 'bulb';
  let report = null, reportDay = '', reportPlain = '', reportBusy = false;
  let setup = null, agentsInfo = null, editing = null, gh = null, ghError = '', ghLoading = false, ghRepo = '', ghQuery = '', projectQuery = '';
  let ghFilter = { who: 'assigned', login: '', state: 'open', label: '' };
  // Mirrors the WHO modes in lib/github.mjs.
  const WHO = [['assigned', 'Assigned to me'], ['created', 'Created by me'], ['mentioned', 'Mentioning me'], ['involved', 'Involving me'], ['user', 'Assigned to a GitHub user'], ['anyone', 'Anyone']];
  try {
    const saved = JSON.parse(localStorage.getItem('factory-scenario-v1'));
    if (saved) { rates = validateAssumptions(saved.rates); if (OBJECTS[saved.object]) object = saved.object; }
  } catch { /* Invalid or unavailable storage uses explicit defaults. */ }
  const task = () => data.issues.find(i => i.id === selected);
  const status = (i) => i.blocked ? 'Your turn · paused' : i.stage === 'ready' ? 'Your turn · review' : (i.stageTitle || i.stage).replaceAll('-', ' ');
  // Results and problems share one strip; a problem says so in words and can be dismissed.
  const notice = (message, problem = false, link = null) => {
    const box = $('notice');
    box.className = problem ? 'fd-notice-problem' : '';
    box.setAttribute('role', problem ? 'alert' : 'status');
    box.innerHTML = message ? `<span>${problem ? 'Problem: ' : ''}${escape(message)}${link ? ` ${externalLink(link.url, link.text)}` : ''}</span><button type="button" class="fd-link" id="notice-close">Dismiss</button>` : '';
  };
  // Explanations are one switch for every page: off shows status and actions only, on adds the sentences that explain them.
  let explaining = false;
  try { explaining = localStorage.getItem('factory-explain') === 'on'; } catch { /* The choice lasts for this visit only. */ }
  const applyExplain = () => { document.body.classList.toggle('fd-explain-on', explaining); $('explain').setAttribute('aria-pressed', explaining); };
  $('explain').onclick = () => { explaining = !explaining; try { localStorage.setItem('factory-explain', explaining ? 'on' : 'off'); } catch { /* Kept for this visit. */ } applyExplain(); };
  applyExplain();
  // Sections of a task that open on demand stay open across data loads.
  const openFolds = new Set();
  const fold = (key, title, body, open = false) => { const id = `${selected}:${key}`; return `<details class="fd-fold fd-keep" data-fold="${escape(key)}"${openFolds.has(id) || (open && !openFolds.has(`${id}:closed`)) ? ' open' : ''}><summary>${title}</summary><div class="fd-fold-body">${body}</div></details>`; };
  document.addEventListener('toggle', e => { const key = e.target.dataset?.fold; if (!key || !selected) return; const id = `${selected}:${key}`; if (e.target.open) { openFolds.add(id); openFolds.delete(`${id}:closed`); } else { openFolds.delete(id); openFolds.add(`${id}:closed`); } }, true);
  $('notice').onclick = e => { if (e.target.id === 'notice-close') notice(''); };
  // Mirrors TITLES in lib/workflow.mjs, for places that only have a stage key.
  const STEP_NAMES = { gates: 'checks', ready: 'your review', approved: 'open the PR', 'pr-opened': 'PR opened' };
  const stepName = (stage, id) => data.issues.find(i => i.id === id)?.steps?.find(x => x.stage === stage)?.title || STEP_NAMES[stage] || stage;
  const externalLink = (url, label) => /^https:\/\/github\.com\//i.test(url || '') ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>` : escape(label);
  async function post(pathname, body) {
    const response = await fetch(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Factory-Token': window.__factoryToken }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Action failed.');
    return result;
  }
  function show(next) {
    view = next;
    document.querySelectorAll('.fd-nav [data-view]').forEach(b => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    // The work queue has its own bar with the layout switch and New task; every other page starts with its own heading.
    $('toolbar').hidden = view !== 'work';
    syncHash();
    ['work', 'github', 'report', 'map', 'projects', 'workflow', 'activity', 'metrics', 'settings'].forEach(id => { $(id).hidden = id !== view; });
    applyQueueMode();
    if (view === 'projects' || view === 'settings') loadSetup();
    if (view === 'workflow') workflow.open();
    if (view === 'report' && !report) loadReport();
    if (view === 'github' && !gh && !ghLoading) loadGithub();
  }
  function checklist(full = false) {
    if (!served) return '';
    if (!setup) return '<p class="fd-caption">Checking setup…</p>';
    const row = (ok, text, fix) => `<li><span class="${ok ? 'fd-pass' : 'fd-warning'}">${ok ? '✓' : '!'}</span> ${escape(text)}${ok || !fix ? '' : `<br><span class="fd-caption">${escape(fix)}</span>`}</li>`;
    const bare = data.projects.filter(p => !p.gates.length).map(p => p.key);
    const rows = [...setup.checks.map(c => [c.ok, c.name, c.fix]),
      [data.projects.length > 0, `${data.projects.length} project(s) registered`, 'Register one on the Projects page, or run "factory setup" in your terminal.'],
      [!bare.length, bare.length ? `No check configured: ${bare.join(', ')}` : 'Every project has a check', 'Open Projects and use Edit to add one.'],
      [setup.hooksInstalled, 'Claude Code guard hooks', 'Optional. Run "factory hooks --install" in your terminal.']];
    const open = rows.filter(([ok]) => !ok).length;
    // Elsewhere than on Settings the list appears only when something needs the user.
    if (!full && !open) return '';
    return `<details class="fd-setup" ${open || full ? 'open' : ''}><summary>Setup · ${open ? `${open} item(s) to look at` : 'all checks pass'}</summary><ul class="fd-checks">${rows.map(r => row(...r)).join('')}</ul><p class="fd-caption">Workspace <code>${escape(setup.workspace)}</code> · data <code>${escape(setup.root)}</code></p></details>`;
  }
  // Marks Settings in the navigation when a setup check fails, so the list itself need not sit on every page.
  function setupAttention() {
    const failing = setup ? setup.checks.filter(c => !c.ok).length + (setup.hooksInstalled ? 0 : 1) : 0;
    const button = document.querySelector('.fd-nav [data-view="settings"]');
    button.innerHTML = `Settings${failing ? ` <span class="fd-attn" title="${failing} setup item(s) to look at">${failing}</span>` : ''}`;
  }
  function renderSettings() {
    $('settings').innerHTML = `<header class="fd-page-head"><div><h2 class="fd-h1">Settings</h2><p class="fd-desc">Settings of this machine: the tools Codeignite needs and the agents the board runs. They are not part of the team export.</p></div></header>${checklist(true)}${agentsSection()}`;
  }
  async function loadSetup() {
    if (!served) return;
    try {
      const response = await fetch('/api/setup');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not read the setup state.');
      setup = result;
      const agents = await fetch('/api/agents');
      if (agents.ok) agentsInfo = await agents.json();
    } catch (error) { notice(error.message, true); return; }
    setupAttention();
    if (document.querySelector('dialog[open]')) return;
    renderProjects(); renderSettings();
    if (!task()) renderDetail();
  }
  const doc = (title, content) => `<section><h3>${escape(title)}</h3>${content ? `<pre>${escape(content)}</pre>` : '<p class="fd-caption">Not recorded yet.</p>'}</section>`;
  function saveAssumptions() {
    try { localStorage.setItem('factory-scenario-v1', JSON.stringify({ rates, object })); }
    catch { notice('Assumptions apply now, but this browser could not save them for next time.'); }
  }
  // When a launch button was last used, per task, so the page stops offering it right away.
  const launched = {};
  let queueMode = 'board';
  try { if (localStorage.getItem('factory-queue-mode') === 'list') queueMode = 'list'; } catch { /* The board is the default when storage is unavailable. */ }
  function applyQueueMode() {
    const onWork = view === 'work';
    $('queue-mode').hidden = !onWork;
    $('board').hidden = !onWork || queueMode !== 'board';
    $('work').hidden = !onWork || queueMode === 'board';
    for (const b of $('queue-mode').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.mode === queueMode);
  }
  $('queue-mode').onclick = e => {
    const mode = e.target.closest('[data-mode]')?.dataset.mode;
    if (!mode) return;
    queueMode = mode;
    try { localStorage.setItem('factory-queue-mode', mode); } catch { /* The choice lasts for this visit only. */ }
    applyQueueMode(); syncHash();
  };
  const needsYou = (i) => Boolean(i.blocked) || i.stage === 'ready' || i.stage === 'approved';
  const failingGate = (i) => i.gates.find(g => g.status === 'failed');
  // Says what the task waits for; colour is never the only signal.
  function queueStatus(i) {
    if (i.blocked) return { text: i.blockedKind === 'unclear' ? 'Your turn · answer the agent' : i.blockedKind === 'attempts' ? 'Your turn · agent stopped' : 'Your turn · paused', cls: i.blockedKind === 'attempts' ? 'fd-fail' : 'fd-warning' };
    if (i.stage === 'ready') return { text: 'Your turn · review', cls: 'fd-warning' };
    if (i.stage === 'approved') return { text: i.kind === 'review' ? 'Your turn · post the review' : 'Your turn · create the PR', cls: 'fd-warning' };
    const failed = failingGate(i);
    if (failed) return { text: `Check "${failed.name}" failed`, cls: 'fd-fail' };
    return { text: `Agent · ${(i.stageTitle || i.stage).replaceAll('-', ' ')}`, cls: 'fd-muted' };
  }
  const checkClass = (value) => value === 'passed' || value === 'pass' ? 'fd-pass' : value === 'failed' || value === 'fail' ? 'fd-fail' : 'fd-warning';
  const check = (value) => `<span class="${checkClass(value)}">${escape(value)}</span>`;
  // The steps of this task's own workflow, with the ones already passed and the current one marked.
  function progress(i) {
    const steps = i.steps || [], at = steps.findIndex(x => x.stage === i.stage);
    return `<ol class="fd-steps" aria-label="Steps">${steps.map((x, n) => { const skipped = i.tier === 'trivial' && n < at && (x.stage === 'reproduce' || x.stage === 'plan'); return `<li class="${n < at ? 'fd-done' : n === at ? 'fd-current' : ''}${skipped ? ' fd-skipped' : ''}"${n === at ? ' aria-current="step"' : ''}><span>${escape(x.title)}${skipped ? ' (skipped)' : ''}</span>${n < at && !skipped ? '<span class="sr-only"> (done)</span>' : ''}</li>`; }).join('')}</ol>`;
  }

  const COLUMNS = [['you', 'Your turn', 'review · answer · failures'], ['start', 'Understand', 'triage · reproduce · plan'], ['build', 'Build', 'implement'], ['check', 'Check', 'checks · verify'], ['ship', 'Ship', 'open the PR · PR opened']];
  // The column follows the task's own workflow, so steps you added land in the right place.
  const columnOf = (i) => needsYou(i) ? 'you' : i.phase === 'review' ? 'you' : i.phase || 'start';
  const span = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 172800 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`; };
  const agoShort = (iso) => span(Date.now() - new Date(iso).getTime());
  const callText = (c) => c.kind === 'mcp' ? `MCP ${c.label}${c.detail ? ` · ${c.detail}` : ''}` : c.kind === 'skill' ? `skill ${c.label}` : c.kind === 'agent' ? `${c.label} agent` : c.detail ? `${c.label}: ${c.detail}` : c.label;
  // The newest sign of an agent on a task: a tool call a hook reported, or a write to a linked session.
  const ACTIVE_MS = 120000;
  const lastSeen = (i) => Math.max(Date.parse(i.activity?.lastInside?.at || '') || 0, Date.parse(i.lastActivity || '') || 0);
  // A run the board started counts as working for as long as it lasts, also between two tool calls.
  const running = (i) => i.run?.status === 'running';
  const isActive = (i) => !i.blocked && (running(i) || Date.now() - lastSeen(i) < ACTIVE_MS);
  // The kind is written out, so the chip colour is never the only signal.
  const actChip = (item) => `<span class="fd-achip fd-achip-${escape(item.kind)}">${escape(item.kind === 'mcp' ? `MCP ${item.label}` : item.kind === 'skill' ? `skill ${item.label}` : item.kind === 'agent' ? `${item.label} agent` : item.label)} ${number(item.count)}</span>`;
  const liveInner = (i) => {
    const seen = lastSeen(i), a = i.activity;
    if (!seen) return '<span class="fd-idle"></span><span class="fd-muted">No agent has worked on this yet</span>';
    const since = agoShort(new Date(seen).toISOString());
    return isActive(i) ? `<span class="fd-pulse"></span><span>Agent working${a?.lastInside ? ` · ${escape(callText(a.lastInside))}` : ''} · ${since} ago</span>` : `<span class="fd-idle"></span><span>Last agent activity ${since} ago</span>`;
  };
  const liveLine = (i) => `<div class="fd-live" data-live="${escape(i.id)}">${liveInner(i)}</div>`;
  const currentStage = (i) => i.activity.byStage.find(s => s.stage === i.stage);
  function renderBoard() {
    if (!data.issues.length) { $('kanban').innerHTML = `<div class="fd-empty"><h2 class="fd-h1">Your workspace is ready.</h2>${data.projects.length ? '<p>No task is in flight. Pick an issue under GitHub issues, or use New task. It appears here and moves across the board as its checks pass.</p>' : '<p>No project is registered yet. Run <code>factory setup</code>, or register projects on the Projects page.</p>'}${checklist()}</div>`; renderDrawer(); return; }
    const card = i => { const st = queueStatus(i); return `<button class="fd-tcard" data-peek="${escape(i.id)}" aria-pressed="${i.id === peek}"><span class="fd-repo"><span>${escape(i.repo)}</span><span>${i.kind === 'review' ? 'PR ' : ''}#${escape(i.issue)}</span></span><strong>${escape(i.title)}</strong><span class="fd-status ${st.cls}">${escape(st.text)}</span><span class="fd-tcard-meta">${i.tier === 'trivial' ? 'trivial · ' : ''}${agoShort(i.stageSince)} in this step${i.reach.length ? ` · reaches ${plural(i.reach.length, 'project')}` : ''}</span>${liveLine(i)}</button>`; };
    // Only columns with tasks are drawn; the empty ones are named in one line, so a single card is not lost among them.
    const filled = COLUMNS.filter(([key]) => data.issues.some(i => columnOf(i) === key));
    $('board-empty-cols').textContent = filled.length < COLUMNS.length ? `Nothing in: ${COLUMNS.filter(c => !filled.includes(c)).map(c => c[1]).join(', ')}.` : '';
    $('kanban').style.setProperty('--fd-cols', filled.length);
    $('kanban').innerHTML = filled.map(([key, title, sub]) => { const items = data.issues.filter(i => columnOf(i) === key); return `<section class="fd-col${key === 'you' ? ' fd-col-you' : ''}" aria-label="${title}"><h3><span>${title}</span><span class="fd-muted">${items.length}</span></h3><p class="fd-col-sub">${sub}</p>${items.map(card).join('')}</section>`; }).join('');
    renderDrawer();
  }
  function agentActivity(i) {
    const a = i.activity;
    const rows = a.byStage.map(s => { const at = s.stage === i.stage, ms = (s.ms || 0) + (s.since ? Date.now() - new Date(s.since).getTime() : 0), visited = s.ms !== null || s.since; return `<div class="fd-stage${at ? ' fd-stage-now' : ''}${visited ? '' : ' fd-stage-todo'}"><div class="fd-stage-name">${escape(s.stage.replaceAll('-', ' '))}<small>${visited ? `${span(ms)}${at ? ' · now' : ''}` : ''}</small></div><div>${s.items.length ? `<div class="fd-achips">${s.items.map(actChip).join('')}</div>` : `<span class="fd-muted">${visited ? 'No calls recorded' : 'Not started'}</span>`}</div></div>`; }).join('');
    return `<div class="fd-anow${isActive(i) ? ' fd-anow-on' : ''}"><div class="fd-live" data-live="${escape(i.id)}">${liveInner(i)}</div><span class="fd-muted">In this step for ${agoShort(i.stageSince)} · ${a.recorded ? `${number(a.calls)} recorded call${a.calls === 1 ? '' : 's'}` : 'no hook has reported on this task'}</span></div><h3 class="fd-gap">Agent activity by step</h3>${rows}<p class="fd-caption fd-explain">Tool names and counts come from the session hooks of a supported harness. Command text beyond the program name, file paths and file contents are not stored. A call counts for this task when it runs inside the task worktree or names the task. No recorded activity means unknown, not idle.</p>`;
  }
  function renderDrawer() {
    const i = data.issues.find(x => x.id === peek);
    $('drawer').hidden = !i; $('board').classList.toggle('fd-board-open', Boolean(i));
    if (!i) { showPane('list'); return; }
    // The drawer leads with what to do, the same panel the task page shows; the agent's activity is one click below.
    $('drawer').innerHTML = `<button class="fd-btn fd-back" data-close>← Board</button><p class="fd-crumb">${externalLink(i.url, `${i.repo} / ${i.kind === 'review' ? 'PR ' : ''}#${i.issue}`)}</p><h2 class="fd-h1">${escape(i.title)}</h2>${nowPanel(i, true)}<div class="fd-actions">${i.stage === 'ready' && !i.blocked ? '' : '<button class="fd-btn" data-open="">Open the task</button>'}<button class="fd-btn fd-ghost fd-drawer-close" data-close>Close</button></div><details class="fd-more fd-keep"><summary>What the agent did, step by step</summary>${i.activity ? agentActivity(i) : '<p class="fd-caption">No activity recorded.</p>'}</details>`;
  }
  // Keeps "3 s ago" and the working marker current between data loads, without redrawing cards.
  function tick() {
    document.querySelectorAll('[data-live]').forEach(el => { const i = data.issues.find(x => x.id === el.dataset.live); if (i) el.innerHTML = liveInner(i); });
    if (!served) return;
    const working = data.issues.filter(isActive).length;
    $('connection').textContent = lost ? 'Disconnected · showing last loaded data' : paused ? 'Paused · newer data loads when you finish here' : working ? `Live · ${working} agent${working === 1 ? '' : 's'} working` : 'Live · no agent working right now';
  }
  // Map: how the registered projects depend on each other, and what a change in one of them reaches.
  let mapSel = null, mapMode = 'explore';
  // True while newer data waits for the user to leave a field, a log or a dialog.
  let paused = false;
  // Buttons that open an agent session on the task, with the first message filled in.
  function launch(i, primary = true) {
    if (!i.prompt || !i.worktree) return '';
    const terminal = `claude-cli://open?q=${encodeURIComponent(i.prompt)}&cwd=${encodeURIComponent(i.worktree)}`;
    const vscode = `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(i.prompt)}`;
    return `<div class="fd-actions"><a class="fd-btn ${primary ? 'fd-primary' : ''}" href="${escape(terminal)}">Open in terminal</a><a class="fd-btn" href="${escape(vscode)}">Open in VS Code</a><button class="fd-btn" type="button" data-copy-prompt>Copy the prompt</button></div><details class="fd-launch-help"><summary>How these buttons work</summary><ul><li><strong>Terminal</strong> opens Claude Code in the task's folder with the message typed in. Press Enter to send it. It works after you have used <code>claude</code> in a terminal once on this machine.</li><li><strong>VS Code</strong> opens a new Claude Code chat in the window you last used, with the message typed in. Open the task's folder there first: <code>${escape(i.worktree)}</code></li><li><strong>WebStorm and other editors</strong> have no such link. Copy the prompt and paste it into the Claude panel or its terminal.</li></ul></details>`;
  }
  // Starts and stops the user's own coding agent from the board, and says how its last run ended.
  function runBlock(i, manual) {
    if (!served) return manual;
    const r = i.run, tool = escape(r?.harness || 'your coding agent');
    const log = r?.log ? `<a class="fd-btn" href="/${escape(r.log)}" target="_blank" rel="noopener" data-agent-log>Open the log</a>` : '';
    const own = (summary) => `<details class="fd-launch-more"><summary>${summary}</summary>${manual}</details>`;
    if (r?.status === 'running') {
      return `<p class="fd-now-live"><span class="fd-dot"></span>Codeignite is running ${tool} on this task: session ${r.sessions || 1}${r.stage ? `, step "${escape(stepName(r.stage, i.id))}"` : ''}${r.model ? `, model ${escape(r.model)}` : ''}. Started ${agoShort(r.startedAt)} ago.</p><div class="fd-actions"><button class="fd-btn" type="button" data-stop-agent>Stop the agent</button>${log}</div><p class="fd-caption fd-explain">It works step by step and stops by itself when the task needs you. Stopping interrupts the session; committed work stays.</p>`;
    }
    if (r?.status === 'queued') {
      return `<p class="fd-now-live"><span class="fd-idle"></span>Waiting for a free slot. At most ${number(data.agents?.maxConcurrent || 1)} agent${data.agents?.maxConcurrent === 1 ? ' runs' : 's run'} at once; change it under Settings.</p><div class="fd-actions"><button class="fd-btn" type="button" data-stop-agent>Take it out of the queue</button></div>`;
    }
    const failed = r && ['error', 'stalled', 'missing', 'interrupted', 'limit'].includes(r.reason);
    const last = r ? `<p class="${failed ? 'fd-warning' : 'fd-caption'}">The last run ended ${r.endedAt ? `${agoShort(r.endedAt)} ago` : 'without a record of when'} after ${plural(r.sessions, 'session')}: ${escape(r.detail || 'no reason was recorded.')}</p>${r.denials?.length && !/Refused commands/.test(r.detail || '') ? `<p class="fd-caption">Refused commands: ${r.denials.map(d => `<code>${escape(d)}</code>`).join(', ')}. If the agent needs one, allow it for this project under Projects, Edit.</p>` : ''}${r.limit ? `<p class="fd-warning">Your account's usage limit answered "${escape(r.limit.status)}"${r.limit.resetsAt ? `; it resets ${escape(new Date(r.limit.resetsAt).toLocaleString())}` : ''}.</p>` : ''}${r.said ? `<details class="fd-launch-more"><summary>The agent's last message</summary><pre class="fd-now-doc">${escape(r.said)}</pre></details>` : ''}` : '';
    const mode = data.projects.find(p => p.key === i.repo)?.agent?.permission || data.agents?.permission || '';
    return `${last}<div class="fd-actions"><button class="fd-btn fd-primary" type="button" data-run-agent>${r ? 'Run the agent again' : 'Run agent'}</button>${log}</div><p class="fd-caption fd-explain">Starts ${escape(data.agents?.label || 'your coding agent')} in the background with your own login, one fresh session per step, until the task needs you.${mode ? ` Permission mode: ${escape(data.agents?.modes?.[mode] || mode)}.` : ''} Change the mode and the limits under Settings.</p>${own('Or open a session yourself')}`;
  }
  const canDecide = (i) => Boolean(served && i.stage === 'ready' && !i.blocked && i.approvalKey);
  // Keeps the decision and its commit on screen while the user reads the task.
  const decideBar = (i) => canDecide(i) ? `<footer class="fd-footer" aria-label="Your decision"><div class="fd-actions"><button class="fd-btn fd-primary" data-action="approve">Approve this version</button><button class="fd-btn" data-action="reject">Send back</button><span class="fd-branch">commit ${escape((i.head || '').slice(0, 12))}</span></div></footer>` : '';
  const archiveBlock = () => served ? '<section class="fd-archive"><h3>Archive</h3><p class="fd-caption fd-explain">Archiving hides the task and removes its worktree. The branch and the recorded evidence are kept.</p><button class="fd-btn" data-action="archive">Archive task</button></section>' : '';
  // Says what is happening with the task and what the user can do about it, in one panel.
  function nowPanel(i, inDrawer = false) {
    const lead = { you: 'Your turn: ', agent: '', done: '' };
    const panel = (who, title, body) => `<section class="fd-now fd-now-${who}" aria-label="What is happening"><h3 class="fd-now-title">${lead[who]}${title}</h3>${body}</section>`;
    const name = escape(i.stageTitle || i.stage);
    if (i.blocked && i.blockedKind === 'unclear') {
      const posted = i.questionsPosted ? `<p class="fd-pass">You posted these on the issue${i.questionsPosted.url ? `: ${externalLink(i.questionsPosted.url, 'open the comment')}` : ''}. When the answer arrives, put it below so the agent can continue.</p>` : '';
      return panel('you', 'the agent has questions before it starts', `<p>It read the issue and the code and found the issue unclear, so it stopped and wrote the questions below. Nothing was posted or changed.</p><pre class="fd-now-doc">${escape(i.docs.questions || 'The questions file is missing.')}</pre>${posted}<p>Choose what to do:</p><div class="fd-actions">${served ? `<button class="fd-btn fd-primary" type="button" data-unblock="answer">Answer here and continue</button>${i.questionsPosted ? '' : '<button class="fd-btn" type="button" data-post-questions>Post the questions on the issue</button>'}<button class="fd-btn" type="button" data-unblock="skip">Continue without answering</button>` : ''}<button class="fd-btn fd-ghost" type="button" data-copy-doc="questions">Copy the questions</button></div><p class="fd-caption fd-explain">Answering sends your text to the agent, which reads it and judges the issue again. Posting puts the questions on GitHub under your name and keeps the task waiting. The reasoning behind the questions is under Details, Triage.</p>`);
    }
    if (i.blocked) {
      const attempts = i.blockedKind === 'attempts';
      return panel('you', attempts ? 'the agent kept failing at this step and stopped' : 'this task is paused', `<p>${escape(i.blocked)}</p>${attempts ? '<p>Look at the failed runs under <button class="fd-link" type="button" data-tab="proof">Proof</button>. If a check command itself is wrong, fix it under Projects. Then let the agent try again, with a hint if you have one.</p>' : ''}<div class="fd-actions">${served ? `<button class="fd-btn fd-primary" type="button" data-unblock="note">${attempts ? 'Let it try again' : 'Resume the task'}</button>` : ''}</div>`);
    }
    if (i.stage === 'ready') {
      return panel('you', i.kind === 'review' ? 'read the review draft, then decide' : 'review the change, then decide', `<p>The checks passed${i.kind === 'review' ? '' : ' and the verifier agreed'}. Read <button class="fd-link" type="button" data-tab="review">${i.kind === 'review' ? 'the draft' : 'the changes and the PR description'}</button> and <button class="fd-link" type="button" data-tab="proof">the proof</button>. Approving lets the agent ${i.kind === 'review' ? 'post this review' : 'push and open the pull request'}. Sending back returns it to the agent with your reason.</p>${inDrawer ? `<div class="fd-actions"><button class="fd-btn fd-primary" type="button" data-open="review">Review and decide</button></div><p class="fd-caption fd-explain">You approve or send back on the task page, where the changes, the evidence and the description are on screen.</p>` : `<p class="fd-caption fd-explain">${canDecide(i) ? 'Approve or send back in the bar at the bottom of this page. ' : ''}Approval covers the commit and the text shown here. It does not push, merge or post by itself.</p>`}`);
    }
    if (i.stage === 'approved' && i.kind === 'review') {
      return panel('you', 'you approved this review, now post it', `<p>Nothing has been posted yet.</p><div class="fd-actions">${served ? '<button class="fd-btn fd-primary" type="button" data-post-review>Post the review</button>' : ''}</div><p class="fd-caption fd-explain">Posts the approved draft on the pull request with its verdict, under your GitHub name.</p>`);
    }
    if (i.stage === 'pr-opened' || i.stage === 'posted') {
      return panel('done', i.stage === 'posted' ? 'The review is posted' : 'The pull request is open', `<p>${i.changes ? `${plural(i.changes.files, 'file')} changed, every check passed${i.verdict === 'pass' ? ' and the verifier agreed' : ''}. ` : ''}${i.prUrl ? `${externalLink(i.prUrl, 'Open the pull request')}. ` : ''}Archive the task ${i.stage === 'posted' ? 'when you are done with it' : 'once the pull request is merged'}.</p>${served ? '<div class="fd-actions"><button class="fd-btn" type="button" data-action="archive">Archive task</button></div>' : ''}`);
    }
    const missing = (i.missing || []).length ? `<p class="fd-now-label">Before this step is done:</p><ul class="fd-now-list">${i.missing.map(m => `<li>${escape(m)}</li>`).join('')}</ul>` : '<p class="fd-now-label">Nothing is missing for this step. The agent only has to move the task on.</p>';
    const notes = `${i.sentBack ? `<p class="fd-warning">You sent this back: ${escape(i.sentBack)}</p>` : ''}${i.docs.answers ? '<p class="fd-caption">Your answer is waiting for the agent. It reads it when it next works on the task.</p>' : ''}${i.attempts?.failed ? `<p class="fd-caption">${i.attempts.failed} of ${i.attempts.max} failed attempts used at this step.</p>` : ''}`;
    // A session counts as working while its transcript changed in the last few minutes, or right after you opened one here.
    const minutes = lastSeen(i) ? Math.max(0, Math.round((Date.now() - lastSeen(i)) / 60000)) : null;
    const opened = Date.now() - (launched[i.id] || 0) < 3 * 60000;
    // The start buttons stay in reach: a session can die without the board knowing.
    let agent;
    if (isActive(i)) agent = `<p class="fd-now-live"><span class="fd-dot"></span>An agent session is working on this task. Last activity ${minutes < 1 ? 'under a minute' : `${minutes} min`} ago.</p><p class="fd-now-label">Open another session only if that one is gone:</p>${launch(i, false)}`;
    else if (opened) agent = `<p class="fd-now-live"><span class="fd-dot"></span>You opened a session for this task a moment ago. Send the message there; this page updates when the agent starts working.</p><p class="fd-now-label">It did not open? Try again:</p>${launch(i, false)}`;
    else agent = `<p class="fd-now-label">${minutes === null ? 'No agent session has worked on this task yet. Start one:' : `No agent is working on this task right now. The last session was active ${minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} ago. Start one to continue:`}</p>${launch(i)}`;
    // Opening the pull request is mechanical once approved, so the board does it; an agent or the user's own hands remain options.
    if (i.stage === 'approved' && i.kind !== 'review') {
      const own = served ? `<details class="fd-launch-more"><summary>Or open the pull request yourself</summary><p>Push the branch <code>${escape(i.branch)}</code> from <code>${escape(i.worktree)}</code>, open the pull request with the PR description under Review, then paste its address here.</p><form id="pr-form" class="fd-locate"><label><span class="sr-only">Address of the pull request</span><input name="url" type="url" required placeholder="https://github.com/owner/repo/pull/123" autocomplete="off"></label><button class="fd-btn" type="submit">Record the pull request</button></form><p id="pr-error" class="fd-failed" role="alert"></p></details>` : '';
      const create = served ? `<div class="fd-actions"><button class="fd-btn fd-primary" type="button" data-create-pr>Create the pull request</button></div><p class="fd-caption fd-explain">Pushes the branch <code>${escape(i.branch)}</code> and opens the pull request into <code>${escape(i.base)}</code> with the approved description, using your GitHub login.</p>` : '';
      return panel('you', 'you approved this, now create the pull request', `<p>Nothing has been pushed yet.</p>${create}<details class="fd-launch-more"><summary>Or let an agent do it</summary>${agent}</details>${own}`);
    }
    return panel('agent', `The agent is at: ${name}`, `<p>${escape(i.about || 'The agent works on this step.')}</p>${notes}${missing}${runBlock(i, agent)}`);
  }
  function renderQueue() {
    const shown = data.issues.filter(i => `${i.title} ${i.repo} ${i.id}`.toLowerCase().includes(query.toLowerCase()));
    $('task-count').textContent = data.issues.length;
    const row = i => { const s = queueStatus(i); return `<button class="fd-row" data-task="${escape(i.id)}" aria-pressed="${i.id === selected}"><span class="fd-repo"><span>${escape(i.repo)}</span><span>${i.kind === 'review' ? 'PR ' : ''}#${escape(i.issue)}</span></span><strong>${escape(i.title)}</strong><span class="fd-status ${s.cls}">${escape(s.text)}</span><span class="fd-tokens">${i.tokens.availability === 'unavailable' ? 'Usage unavailable' : `${compact(i.tokens.fresh)} new tokens${i.tokens.availability === 'partial' ? ' · partial' : ''}`}${i.reach.length ? ` · reaches ${plural(i.reach.length, 'project')}` : ''}</span></button>`; };
    const group = (title, items) => items.length ? `<h3 class="fd-group"><span>${title}</span><span>${items.length}</span></h3>${items.map(row).join('')}` : '';
    $('tasks').innerHTML = group('YOUR TURN', shown.filter(needsYou)) + group('WITH THE AGENT', shown.filter(i => !needsYou(i))) || `<p class="fd-queue-note">${data.issues.length ? 'No task matches this filter.' : 'No tasks in flight yet.'}</p>`;
  }
  function renderDetail() {
    const i = task();
    if (!i) {
      $('detail').innerHTML = `<div class="fd-empty"><h2 class="fd-h1">Your workspace is ready.</h2>${data.projects.length ? '<p>No task is in flight. Pick an issue under GitHub issues, or use New task with an issue or pull request number. Its progress, evidence, and usage will appear here.</p>' : '<p>No project is registered yet. This command checks your tools and registers every GitHub repository in your workspace:</p><pre>factory setup</pre><p>You can also register them one by one on the Projects page.</p>'}${checklist()}</div>`;
      return;
    }
    // Three tabs: what you approve, what proves it, and everything else. Old addresses still open the right one.
    const TAB_ALIAS = { overview: '', changes: 'review', brief: 'details', agent: 'details', usage: 'details', evidence: 'proof' };
    if (tab in TAB_ALIAS) tab = TAB_ALIAS[tab];
    const tabs = [['review', i.kind === 'review' ? 'Review draft' : 'Review'], ['proof', 'Proof'], ['details', 'Details']];
    if (!tabs.some(([key]) => key === tab)) tab = '';
    // Without a choice the tab follows the step: the change at your review, the proof while checks run, the task itself before that.
    shownTab = tab || (['ready', 'approved'].includes(i.stage) ? 'review' : ['pr-opened', 'posted'].includes(i.stage) || !i.evidence.length ? 'details' : 'proof');
    $('detail').innerHTML = `<div class="fd-head"><button class="fd-btn fd-back" data-back>← All tasks</button><p class="fd-crumb">${externalLink(i.url, `${i.repo} / ${i.kind === 'review' ? 'PR ' : ''}#${i.issue}`)}<span class="${queueStatus(i).cls}">${escape(queueStatus(i).text)}</span>${i.tier === 'trivial' ? '<span class="fd-muted">trivial change</span>' : ''}</p><h2 class="fd-h1">${escape(i.title)}</h2>${progress(i)}</div>${nowPanel(i)}<div class="fd-tabs" role="tablist" aria-label="Task sections">${tabs.map(([key, title]) => `<button role="tab" id="tab-${key}" data-tab="${key}" aria-selected="${shownTab === key}" aria-controls="body">${title}</button>`).join('')}</div><div role="tabpanel" aria-labelledby="tab-${shownTab}" class="fd-body" id="body"></div>${decideBar(i)}`;
    if (shownTab === 'review') renderReview(i);
    else if (shownTab === 'proof') renderEvidence(i);
    else renderDetails(i);
  }
  // Who a change reaches, from the workspace map and the plan.
  function reachBlock(i) {
    const direct = i.reach.filter(r => r.depth === 1), missing = direct.filter(r => !r.mentioned);
    return !i.reach.length ? '' : `<section><h3>Who this change reaches</h3><p><strong>${escape(i.repo)}</strong> is used by ${plural(direct.length, 'project')} directly${i.reach.length > direct.length ? `, and reaches ${number(i.reach.length - direct.length)} more through them` : ''}. ${!i.hasPlan ? 'The plan should say what happens to each direct user under “Consumer impact”.' : missing.length ? `<span class="fd-fail">The plan’s “Consumer impact” does not name ${escape(names(missing.map(r => r.key)))}.</span> Add what happens to ${missing.length === 1 ? 'it' : 'them'}, or why ${missing.length === 1 ? 'it is' : 'they are'} unaffected.` : 'The plan names every direct user.'}</p><div class="fd-evidence">${i.reach.map(r => `<div><span>${escape(r.key)} <span class="fd-muted">· ${r.depth === 1 ? 'direct user' : `through ${escape(r.via)}`}</span></span><span>${r.mentioned ? '<span class="fd-pass">✓ named in the plan</span>' : !i.hasPlan ? '<span class="fd-muted">plan not written yet</span>' : r.depth === 1 ? '<span class="fd-fail">✕ not named in the plan</span>' : '<span class="fd-muted">not named · indirect</span>'}</span></div>`).join('')}</div><p class="fd-caption fd-explain">This is a reminder, not a gate: the task can advance without it.</p><button class="fd-btn" data-show-map="${escape(i.repo)}">Show on the map</button></section>`;
  }
  const reachProblem = (i) => i.hasPlan && i.reach.some(r => r.depth === 1 && !r.mentioned);
  // Review: the text and the change an approval covers. The text is open while the decision is yours.
  function renderReview(i) {
    const draft = i.kind === 'review' ? i.docs.review : i.docs.prBody;
    const title = i.kind === 'review' ? 'Review draft' : 'PR description';
    const text = draft ? fold('draft', `${title}${i.stage === 'ready' ? ' this approval covers' : ''}`, `<pre class="fd-draft">${escape(draft)}</pre>`, i.stage === 'ready') : `<p class="fd-muted">${title}: not written yet.</p>`;
    $('body').innerHTML = `${reachProblem(i) ? reachBlock(i) : ''}${text}<h3 class="fd-gap">Changes</h3><div id="diff"></div>`;
    renderChanges(i);
  }
  // Details: what the task is and what happened to it, each part opened on demand.
  function renderDetails(i) {
    const part = (key, title, content, open = false) => content ? fold(key, title, `<pre>${escape(content)}</pre>`, open) : '';
    const first = !i.docs.triage && !i.docs.plan;
    $('body').innerHTML = `${part('issue', i.kind === 'review' ? 'Pull request' : 'Issue', i.docs.issue || i.docs.pr, first)}${part('triage', 'Triage', i.docs.triage)}${part('questions', 'Open questions', i.docs.questions)}${part('plan', 'Plan', i.docs.plan)}${part('next', 'What the agent is told at this step', i.brief)}${i.reach.length && !reachProblem(i) ? fold('reach', 'Who this change reaches', reachBlock(i)) : ''}${fold('activity', 'What the agent did, step by step', i.activity ? agentActivity(i) : '<p class="fd-caption">No activity data for this task.</p>')}${fold('usage', 'Tokens and footprint', '<div id="usage-box"></div>')}${fold('where', 'Branch and folders', `<div class="fd-evidence"><div><span>Branch</span><span><code>${escape(i.branch)}</code></span></div><div><span>Base</span><span><code>${escape(i.base)}</code></span></div><div><span>Commit</span><span><code>${escape((i.head || 'worktree missing').slice(0, 12))}</code></span></div><div><span>Worktree</span><span><code>${escape(i.worktree || '')}</code></span></div></div>`)}${archiveBlock()}`;
    renderUsage(i);
  }
  const checksTable = (i) => `<div class="fd-evidence">${i.gates.map(g => `<div><span>${escape(g.name)}</span><span>${check(g.status)}${g.verifier ? ` · verifier ${check(g.verifier)}` : ''}</span></div>`).join('') || '<p>No gates configured for this project.</p>'}${i.regress ? `<div><span>Regression proof</span><span>${check(i.regress)}</span></div>` : ''}${i.kind === 'review' ? '' : `<div><span>Verifier verdict</span><span>${i.verdict ? check(i.verdict) : '<span class="fd-muted">not recorded</span>'}</span></div>`}</div>`;
  function renderEvidence(i) {
    const stateOf = (r) => r.stale || r.dirty ? 'stale' : r.ok ? 'pass' : 'fail';
    const runs = [...i.evidence].reverse(), count = (state) => runs.filter(r => stateOf(r) === state).length;
    // One line says how the runs went; a failed run is open, a passed one is a click away.
    const summary = !runs.length ? '<p class="fd-muted">No runs recorded yet.</p>' : `<p>${plural(runs.length, 'run')} recorded: <span class="fd-pass">${count('pass')} passed</span>${count('fail') ? `, <span class="fd-fail">${count('fail')} failed</span>` : ''}${count('stale') ? `, <span class="fd-warning">${count('stale')} from an earlier commit</span>` : ''}.</p>`;
    const run = (r) => { const state = stateOf(r); return `<details class="fd-run"${r.log && served ? ` data-log="${escape(r.log)}"` : ''}><summary><span>${escape(r.name)}</span><span class="${state === 'stale' ? 'fd-warning' : checkClass(state)}">${state.toUpperCase()}</span><span class="fd-muted">${escape(r.actor)} · ${escape((r.sha || '').slice(0, 8))}</span></summary><p class="fd-caption">${escape(r.startedAt)}${r.durationMs !== null ? ` · ${number(r.durationMs / 1000, 1)} seconds` : ''}${r.exitCode !== null ? ` · exit ${escape(r.exitCode)}${r.expect ? `, expected to ${escape(r.expect)}` : ''}` : ''}</p>${r.cmd ? `<pre>${escape(r.cmd)}</pre>` : ''}${r.text ? `<pre>${escape(r.text)}</pre>` : ''}${r.log ? `<pre class="fd-log" hidden></pre><a class="fd-link" href="${escape(r.log)}" target="_blank" rel="noopener noreferrer">Open the full log</a>` : ''}</details>`; };
    const failed = runs.filter(r => stateOf(r) === 'fail'), rest = runs.filter(r => stateOf(r) !== 'fail');
    $('body').innerHTML = `<h3>Checks at the current commit</h3>${i.tampered.length ? `<p class="fd-fail">Evidence integrity problem: ${escape(i.tampered.join('; '))}</p>` : ''}${checksTable(i)}${i.criteria.length ? `<h3 class="fd-gap">Acceptance criteria</h3><ul>${i.criteria.map(x => `<li>${escape(x)}</li>`).join('')}</ul><p class="fd-caption fd-explain">From the plan. The verifier report says how each was checked.</p>` : ''}<h3 class="fd-gap">Recorded runs</h3>${summary}${failed.map(run).join('')}${rest.length ? fold('runs', failed.length ? `The other ${plural(rest.length, 'run')}` : 'Every run', rest.map(run).join('')) : ''}${i.docs.verify ? fold('verify', 'Verifier report', `<pre>${escape(i.docs.verify)}</pre>`) : ''}`;
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
    $('diff').innerHTML = '<p class="fd-caption">Loading committed changes…</p>';
    if (!served) { $('diff').innerHTML = '<p>Changes are available when running the local server.</p>'; return; }
    const id = i.id;
    try {
      const response = await fetch(`/api/diff?id=${encodeURIComponent(id)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load changes.');
      if (selected !== id || shownTab !== 'review' || !$('diff')) return;
      const files = parseDiff(result.diff || '');
      const total = (key) => files.reduce((n, f) => n + f[key], 0);
      $('diff').innerHTML = !files.length ? '<p>No committed changes against the merge base.</p>' : `<p>${number(files.length)} file${files.length === 1 ? '' : 's'} changed · <span class="fd-pass">+${number(total('add'))}</span> <span class="fd-fail">−${number(total('del'))}</span> lines. Committed changes against the merge base; uncommitted edits are excluded.</p>` + files.map(f => `<details class="fd-diff-file fd-keep"${f.lines.length > 600 ? '' : ' open'}><summary><span class="fd-path">${escape(f.name)}</span><span><span class="fd-pass">+${number(f.add)}</span> <span class="fd-fail">−${number(f.del)}</span></span></summary><div class="fd-diff">${f.lines.map(l => `<div${l.kind ? ` class="${l.kind}"` : ''}>${escape(l.text) || ' '}</div>`).join('')}</div></details>`).join('');
    } catch (error) { if (selected === id && shownTab === 'review' && $('diff')) $('diff').textContent = error.message; }
  }
  function scopedUsage(i) { return scope === 'task' ? i.tokens : i.tokens.bySession?.find(session => session.id === scope); }
  function renderUsage(i) {
    if (scope !== 'task' && !i.tokens.bySession?.some(session => session.id === scope)) scope = 'task';
    $('usage-box').innerHTML = `<h3>Token usage</h3><label>Usage scope<select id="usage-scope"><option value="task">Full task · all linked sessions</option>${(i.tokens.bySession || []).map(session => `<option value="${session.id}" ${scope === session.id ? 'selected' : ''}>${escape(session.label)} · linked ${escape(session.linkedAt || 'date unknown')}</option>`).join('')}</select></label><div id="usage-values"></div><section class="fd-energy"><div id="impact"></div><div class="fd-provenance"><strong>Illustrative scenario, not measured consumption.</strong><br>Energy rates: assumed · Provider grid: unknown</div><p class="fd-caption" id="active-assumptions"></p><label>Compare electricity with<select id="object">${Object.entries(OBJECTS).map(([key, value]) => `<option value="${key}" ${object === key ? 'selected' : ''}>${escape(value.label)}</option>`).join('')}</select></label><details id="method"><summary>How this is calculated</summary><div class="fd-method" id="method-values"></div></details><details><summary>Change assumptions</summary><form id="assumptions"><div class="fd-rates">${TOKEN_KINDS.map(key => `<label>${labels[key]} · Wh per million tokens<input name="${key}" type="number" min="0" max="1000000" step="any" required value="${rates[key]}"></label>`).join('')}<label>Carbon intensity · g CO₂e/kWh<input name="carbonIntensity" type="number" min="0" max="5000" step="any" required value="${rates.carbonIntensity}"></label></div><div class="fd-actions"><button class="fd-btn" type="submit">Apply assumptions</button><button class="fd-btn" type="button" id="reset-assumptions">Reset defaults</button></div><p class="fd-caption fd-explain">Saved in this browser. Not provider measurements. Last valid assumptions stay active until you apply changes.</p><p id="rate-error" role="alert"></p></form></details></section>`;
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
    const gates = p.gates.length ? `<ul class="fd-gate-list">${p.gates.map(g => `<li><span class="fd-chip">${escape(g.name)}</span><code title="${escape(g.cmd)}">${escape(g.cmd)}</code></li>`).join('')}</ul>` : '<p><span class="fd-badge fd-badge-warn">No check configured</span></p>';
    return `<article class="fd-card ${kind}"><header><h3>${escape(p.key)}</h3><span class="fd-badge" title="Base branch">${escape(p.baseBranch)}</span></header><div><p class="fd-card-remote">${externalLink(`https://github.com/${p.remote}`, p.remote)}</p>${gates}${p.install ? `<p class="fd-card-install"><span>install</span><code title="${escape(p.install)}">${escape(p.install)}</code></p>` : ''}</div>${footer ? `<footer>${footer}</footer>` : ''}</article>`;
  }
  // The machine's settings for agents the board starts: what they may do, how many run, which login they use.
  function agentsSection() {
    if (!served) return '';
    if (!agentsInfo) return '<h2 class="fd-section">Agents the board runs</h2><p class="fd-caption">Loading…</p>';
    const { settings: s, harness: h, limits } = agentsInfo;
    const options = (list, value) => list.map(o => `<option value="${escape(o.id)}"${o.id === value ? ' selected' : ''}>${escape(o.label)}</option>`).join('');
    const explain = (list) => `<dl class="fd-agent-modes">${list.map(o => `<dt>${escape(o.label)}</dt><dd>${escape(o.about)}</dd>`).join('')}</dl>`;
    return `<h2 class="fd-section">Agents the board runs</h2><p class="fd-caption fd-explain">"Run agent" on a task starts ${escape(h.label)} on this machine with your own login, one fresh session per step, and stops when the task needs you. ${h.version ? `Found: ${escape(h.version)}.` : `<span class="fd-warning">${escape(h.label)} was not found. ${escape(h.install)}</span>`} These settings stay on this machine and are not part of the team export.</p>
<form id="agents-form" class="fd-filter fd-agents"><label>What an agent may do<select name="permission">${options(h.permissionModes, s.permission)}</select></label><label>Account<select name="account">${options(h.accounts, s.account)}</select></label><label>Agents at once<input name="maxConcurrent" type="number" required min="${limits.maxConcurrent[0]}" max="${limits.maxConcurrent[1]}" value="${s.maxConcurrent}"></label><label>Sessions per run, at most<input name="maxSessions" type="number" required min="${limits.maxSessions[0]}" max="${limits.maxSessions[1]}" value="${s.maxSessions}"></label><label class="fd-check"><input name="autoStart" type="checkbox"${s.autoStart ? ' checked' : ''}> Start an agent as soon as a task is created on the board</label><button class="fd-btn fd-primary" type="submit">Save</button><p id="agents-error" class="fd-failed" role="alert"></p></form>
<details class="fd-launch-more fd-keep"><summary>What the choices mean</summary><h3 class="fd-gap">What an agent may do</h3>${explain(h.permissionModes)}<h3 class="fd-gap">Account</h3>${explain(h.accounts)}<p class="fd-caption fd-explain">A project can have its own mode and extra allowed commands: Edit on its card. More agents at once use your plan's limits faster. Whatever the mode, a push, a pull request and a comment wait for your approval of the task.</p></details>`;
  }
  function renderProjectCards() {
    const match = p => `${p.key} ${p.remote}`.toLowerCase().includes(projectQuery.toLowerCase());
    const registered = data.projects.filter(match).sort((a, b) => a.key.localeCompare(b.key));
    const found = served && setup ? setup.candidates.map((c, n) => [c, n]).filter(([c]) => match(c)) : [];
    const actions = p => served ? `<button class="fd-btn" data-edit="${escape(p.key)}">Edit</button><button class="fd-btn fd-ghost" data-remove="${escape(p.key)}">Remove</button>` : '';
    $('project-cards').innerHTML = (registered.length ? `<div class="fd-cards">${registered.map(p => projectCard(p, actions(p))).join('')}</div>` : `<p class="fd-blank">${data.projects.length ? 'No project matches this filter.' : 'No project is registered yet.'}</p>`)
      + (served && setup?.pending?.length ? `<h2 class="fd-section">From your team's setup, not on this machine yet <span>${setup.pending.length}</span></h2><p class="fd-caption fd-explain">These projects came with an imported setup, but their repository was not found in your workspace. Their shared commands and workflow are kept and apply when you add the project. Clone it into the workspace, or if it is already cloned somewhere else, use "Add a project by its folder" below.</p><ul class="fd-asset-list fd-pending">${setup.pending.map(p => `<li><span class="fd-chip">${escape(p.key)}</span>${externalLink(`https://github.com/${p.remote}`, p.remote)}<code>git clone git@github.com:${escape(p.remote)}.git</code></li>`).join('')}</ul>` : '')
      + (found.length ? `<h2 class="fd-section">Found in your workspace <span>${found.length}</span></h2><p class="fd-caption fd-explain">GitHub repositories directly inside the workspace that are not registered. Review the suggested commands before you register one.</p><div class="fd-cards">${found.map(([c, n]) => projectCard(c, `<button class="fd-btn fd-primary" data-register="${n}">Register</button>`, 'fd-card-new')).join('')}</div>` : '');
  }
  function renderProjects() {
    const bare = data.projects.filter(p => !p.gates.length).length;
    const stats = `<span class="fd-stat"><b>${data.projects.length}</b> registered</span>${bare ? `<span class="fd-stat fd-stat-warn"><b>${bare}</b> without a check</span>` : ''}${served && setup?.candidates.length ? `<span class="fd-stat"><b>${setup.candidates.length}</b> not registered</span>` : ''}`;
    $('projects').innerHTML = `<header class="fd-page-head"><div><h2 class="fd-h1">Projects</h2><p class="fd-desc">Each project supplies its own checks. Settings are saved on this machine; Export shares them with your team.</p></div><div class="fd-stats">${stats}${served ? '<button class="fd-btn" type="button" id="export-config" title="Projects, gates and workflow in one file, without paths or task data">Export for the team</button>' : ''}</div></header><div class="fd-bar"><label class="fd-search"><span class="sr-only">Filter projects</span><input id="project-search" type="search" placeholder="Filter by name or repository" value="${escape(projectQuery)}"></label></div><div id="project-cards"></div>${served ? `<h2 class="fd-section">Add a project by its folder</h2><p class="fd-caption fd-explain">For a repository that is not inside the workspace${data.workspace ? ` (${escape(data.workspace)})` : ''}, or one the list above did not find. It needs to be cloned on this machine and have a GitHub origin.</p><form id="locate-form" class="fd-locate"><label><span class="sr-only">Folder of the repository</span><input name="path" required placeholder="~/code/my-app" autocomplete="off" spellcheck="false"></label><button class="fd-btn" type="submit">Find it</button></form><p id="locate-error" class="fd-failed" role="alert"></p>` : ''}<p class="fd-caption fd-page-foot fd-explain">Branch conventions and other project rules live in repos.json in your Codeignite data folder.</p>`;
    renderProjectCards();
  }
  $('projects').addEventListener('submit', async e => {
    if (e.target.id !== 'locate-form') return;
    e.preventDefault();
    $('locate-error').textContent = '';
    try { openProject('add', await post('/api/project/locate', { path: e.target.elements.path.value })); }
    catch (error) { $('locate-error').textContent = error.message; }
  });
  $('settings').addEventListener('submit', async e => {
    if (e.target.id !== 'agents-form') return;
    e.preventDefault();
    const f = e.target.elements;
    $('agents-error').textContent = '';
    try {
      const saved = await post('/api/agents/settings', { permission: f.permission.value, account: f.account.value, maxConcurrent: Number(f.maxConcurrent.value), maxSessions: Number(f.maxSessions.value), autoStart: f.autoStart.checked });
      agentsInfo.settings = saved.settings;
      notice('Agent settings saved. They apply to the next run.');
      document.activeElement?.blur(); refresh();
    } catch (error) { $('agents-error').textContent = error.message; }
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
    const head = '<div><h2 class="fd-h1">Daily report</h2><p class="fd-desc">What was recorded for one day: factory tasks, your commits and your pull requests in the registered projects.</p></div>';
    if (!served) { $('report').innerHTML = `<header class="fd-page-head">${head}</header><p class="fd-blank">This view needs the local server. Run <code>factory board</code>.</p>`; return; }
    const today = dayOf(new Date());
    const controls = `<div class="fd-actions"><button class="fd-btn" type="button" data-report-shift="-1" aria-label="Previous day">←</button><input id="report-day" type="date" aria-label="Day" value="${escape(reportDay)}" max="${today}"><button class="fd-btn" type="button" data-report-shift="1" aria-label="Next day" ${reportDay >= today ? 'disabled' : ''}>→</button><button class="fd-btn" type="button" data-report-day="${today}" ${reportDay === today ? 'disabled' : ''}>Today</button></div>`;
    let body = '<p class="fd-blank">Collecting the day…</p>';
    if (report?.error) body = `<p class="fd-blank fd-failed" role="alert">${escape(report.error)}</p>`;
    else if (report) {
      const tasks = report.tasks.length ? `<h2 class="fd-section">Tasks <span>${report.tasks.length}</span></h2><ul class="fd-issues">${report.tasks.map(t => `<li class="fd-issue"><div><p class="fd-issue-title">${externalLink(t.url, t.title)}</p><p class="fd-issue-meta"><span class="fd-chip">${escape(t.project)}</span><span>${t.kind === 'review' ? 'PR ' : ''}#${escape(t.number)}</span>${t.milestones.map(m => `<span class="fd-badge fd-badge-ok">${escape(m)}</span>`).join('')}<span>${t.from && t.from !== t.to ? `${escape(stepName(t.from, t.id))} → ${escape(stepName(t.to, t.id))}` : `at ${escape(stepName(t.to, t.id))}`}</span>${t.checks.passed + t.checks.failed ? `<span>${t.checks.passed} checks passed, ${t.checks.failed} failed</span>` : ''}${t.prUrl ? externalLink(t.prUrl, 'pull request') : ''}</p></div></li>`).join('')}</ul>` : '';
      const prs = [...report.pullRequests.opened.map(p => ['opened', p]), ...report.pullRequests.merged.map(p => ['merged', p])];
      const pulls = prs.length ? `<h2 class="fd-section">Pull requests <span>${prs.length}</span></h2><ul class="fd-issues">${prs.map(([what, p]) => `<li class="fd-issue"><div><p class="fd-issue-title">${externalLink(p.url, p.title)}</p><p class="fd-issue-meta"><span class="fd-badge fd-badge-ok">${what}</span><span>${escape(p.repo)}#${escape(p.number)}</span></p></div></li>`).join('')}</ul>` : '';
      const commits = report.commits.length ? `<h2 class="fd-section">Commits <span>${report.commits.reduce((n, c) => n + c.count, 0)}</span></h2>${report.commits.map(c => `<details class="fd-panel fd-general"><summary>${escape(c.project)} · ${c.count}</summary><ul class="fd-asset-list">${c.commits.map(x => `<li><code>${escape(x.sha)}</code><span>${escape(x.subject)}</span></li>`).join('')}</ul></details>`).join('')}` : '';
      body = `<div class="fd-wf-grid"><section class="fd-panel"><div class="fd-editor-head"><h3>Summary from the records</h3><button class="fd-btn" type="button" data-copy="report-summary">Copy</button></div><pre id="report-summary" class="fd-report">${escape(report.summary)}</pre></section><section class="fd-panel"><div class="fd-editor-head"><h3>In plain English</h3>${reportPlain ? '<button class="fd-btn" type="button" data-copy="report-plain">Copy</button>' : ''}</div>${reportPlain ? `<pre id="report-plain" class="fd-report">${escape(reportPlain)}</pre><p class="fd-caption fd-explain">Written by Claude from the summary on the left. Check it against the records before you send it.</p><button class="fd-btn" type="button" id="report-write" ${reportBusy ? 'disabled' : ''}>${reportBusy ? 'Writing…' : 'Write it again'}</button>` : `<p class="fd-caption fd-explain" style="margin-top:12px">Claude Code on this machine can rewrite the summary as a few short sentences for someone who does not read commit messages. It receives only the summary text on the left and has no tools. It takes up to a minute.</p><button class="fd-btn fd-primary" type="button" id="report-write" ${reportBusy ? 'disabled' : ''}>${reportBusy ? 'Writing…' : 'Write it in plain English'}</button>`}<p id="report-error" class="fd-failed" role="alert"></p></section></div>${tasks}${pulls}${commits}${report.pullRequests.error ? `<p class="fd-caption fd-page-foot">${escape(report.pullRequests.error)}</p>` : ''}`;
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
    // A project's own agent settings exist once it is registered.
    $('project-agent').hidden = mode !== 'edit' || !agentsInfo;
    if (agentsInfo) form.elements.agentPermission.innerHTML = `<option value="">Same as this machine's setting</option>${agentsInfo.harness.permissionModes.map(o => `<option value="${escape(o.id)}">${escape(o.label)}</option>`).join('')}`;
    form.elements.agentPermission.value = p.agent?.permission || '';
    form.elements.agentAllow.value = (p.agent?.allow || []).join('\n');
    editing.agent = JSON.stringify(agentOf(form));
    $('project-error').textContent = '';
    $('project-dialog').showModal();
  }
  const agentOf = (form) => ({ permission: form.elements.agentPermission.value, allow: form.elements.agentAllow.value.split('\n').map(line => line.trim()).filter(Boolean) });
  $('add-gate').onclick = () => { $('project-gates').insertAdjacentHTML('beforeend', gateRow()); $('project-gates').lastElementChild.querySelector('input').focus(); };
  $('project-gates').onclick = e => { if (e.target.closest('[data-drop-gate]')) e.target.closest('.fd-gate').remove(); };
  $('cancel-project').onclick = () => $('project-dialog').close();
  $('project-form').onsubmit = async e => {
    e.preventDefault();
    const form = e.target, base = form.elements.baseBranch.value.trim(), install = form.elements.install.value.trim();
    const gates = [...$('project-gates').querySelectorAll('.fd-gate')].map(row => ({ name: row.querySelector('[data-gate=name]').value.trim(), cmd: row.querySelector('[data-gate=cmd]').value.trim(), ...(row.dataset.cwd ? { cwd: row.dataset.cwd } : {}) }));
    $('save-project').disabled = true;
    try {
      if (editing.mode === 'edit') await post('/api/project/update', { key: editing.key, gates, ...(base !== editing.baseBranch ? { baseBranch: base } : {}), ...(install !== editing.install ? { install } : {}), ...(!$('project-agent').hidden && JSON.stringify(agentOf(form)) !== editing.agent ? { agent: agentOf(form) } : {}) });
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
    } catch (error) { notice(error.message, true); }
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
      openAction('Remove project');
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
    const row = i => `<li class="fd-issue"><div><p class="fd-issue-title">${externalLink(i.url, i.title)}</p><p class="fd-issue-meta"><span class="fd-chip">${escape(i.project)}</span><span>#${escape(i.number)}</span><span title="${escape(i.updatedAt)}">updated ${escape(ago(i.updatedAt))}</span>${i.assignees.length ? `<span>${escape(i.assignees.join(', '))}</span>` : ''}${i.labels.map(l => `<span class="fd-label">${escape(l.replace(/:[a-z0-9_+-]+:\s*/g, '') || l)}</span>`).join('')}</p></div><div class="fd-issue-action">${i.task ? `<span class="fd-badge fd-badge-ok">${escape(stepName(i.task.stage, i.task.id))}</span><button class="fd-btn" data-open-task="${escape(i.task.id)}">Open the task</button>` : `<button class="fd-btn" data-start-project="${escape(i.project)}" data-start-number="${escape(i.number)}">Start task</button>`}</div></li>`;
    $('gh-results').innerHTML = chips + (shown.length ? `<ul class="fd-issues">${shown.map(row).join('')}</ul>` : `<p class="fd-blank">${all.length ? 'No loaded issue matches the search or the selected project.' : ghFilter.who === 'assigned' ? 'No open issue is assigned to you in these projects. Set "Show issues" to Anyone to see every open issue.' : 'No issues match these choices.'}</p>`)
      + `<p class="fd-caption fd-page-foot">${plural(shown.length, 'issue')} shown of ${all.length}.${all.length >= gh.limit ? ` GitHub returned the ${gh.limit} most recently updated; narrow the filter to see the rest.` : ''}</p>`;
  }
  function renderGithub() {
    const head = '<div><h2 class="fd-h1">GitHub issues</h2><p class="fd-desc">Issues in your registered projects, read through the GitHub CLI on this machine.</p></div>';
    if (!served) { $('github').innerHTML = `<header class="fd-page-head">${head}</header><p class="fd-blank">This view needs the local server. Run <code>factory board</code>.</p>`; return; }
    const f = ghFilter;
    const option = (value, label, current) => `<option value="${escape(value)}" ${value === current ? 'selected' : ''}>${escape(label)}</option>`;
    const state = (value, label) => `<label><input type="radio" name="state" value="${value}" ${f.state === value ? 'checked' : ''}><span>${label}</span></label>`;
    $('github').innerHTML = `<header class="fd-page-head">${head}<div class="fd-actions"><span class="fd-caption" id="gh-loaded" role="status"></span><button class="fd-btn" type="button" id="gh-refresh">Refresh</button></div></header><form id="gh-filter" class="fd-panel fd-filter"><label>Show issues<select name="who">${WHO.map(([value, label]) => option(value, label, f.who)).join('')}</select></label><label id="gh-login" ${f.who === 'user' ? '' : 'hidden'}>GitHub login<input name="login" value="${escape(f.login)}" placeholder="octocat"></label><fieldset class="fd-seg"><legend>State</legend><div>${state('open', 'Open')}${state('closed', 'Closed')}</div></fieldset><label>Label<input name="label" value="${escape(f.label)}" placeholder="Any label"></label><p class="fd-caption fd-explain">These choices are saved and reload the list as soon as you change one. The search and the project chips below only narrow what is already loaded.</p></form><div class="fd-bar"><label class="fd-search"><span class="sr-only">Search loaded issues</span><input id="gh-search" type="search" placeholder="Search loaded issues by title, number or label" value="${escape(ghQuery)}"></label></div><div id="gh-results"></div>`;
    renderGithubList();
  }
  $('github').addEventListener('input', e => { if (e.target.id === 'gh-search') { ghQuery = e.target.value; renderGithubList(); } });
  $('github').addEventListener('change', e => {
    if (e.target.name === 'who') $('gh-login').hidden = e.target.value !== 'user';
    // A login is typed after "who" changes to a user, so that case waits for the login field.
    if (e.target.closest('#gh-filter') && !(e.target.name === 'who' && e.target.value === 'user' && !$('gh-filter').elements.login.value.trim())) $('gh-filter').requestSubmit();
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
  const node = (key) => data.graph.nodes.find(n => n.key === key);
  const clip = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const names = (keys) => keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`;
  function layoutGraph() {
    const W = 236, H = 92, GX = 44, GY = 86, layers = [], pos = {};
    // A layer with many projects wraps into rows of four, so the labels stay readable.
    const byLayer = [];
    data.graph.nodes.forEach(n => (byLayer[n.layer] ||= []).push(n));
    for (const layer of byLayer) for (let at = 0; at < (layer || []).length; at += 4) layers.push(layer.slice(at, at + 4));
    const rowOf = new Map(layers.flatMap((row, index) => row.map(n => [n.key, index])));
    const width = Math.max(...layers.map(l => l.length)) * (W + GX) - GX;
    layers.forEach((layer, index) => {
      // Places a project near the middle of what it depends on, which keeps most arrows from crossing.
      const above = n => n.dependsOn.filter(d => rowOf.get(d.key) < index);
      const centre = n => above(n).reduce((sum, d) => sum + pos[d.key].x, 0) / (above(n).length || 1);
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
      const cls = n.key === mapSel ? ' fd-gnode-sel' : reached.has(n.key) ? ' fd-gnode-hit' : tracing ? ' fd-dim' : '';
      return `<g class="fd-gnode${cls}" data-node="${escape(n.key)}" tabindex="0" role="button" aria-pressed="${n.key === mapSel}" aria-label="${escape(`${n.key}. ${n.description || 'No description'}. Used by ${n.usedBy.length}.`)}"><title>${escape(n.description || n.key)}</title><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="4"/><text x="${p.x + 14}" y="${p.y + 27}" class="fd-gnode-name">${escape(clip(n.key, step ? 22 : 26))}</text><text x="${p.x + 14}" y="${p.y + 48}" class="fd-gnode-role">${escape(clip(n.description || n.remote || '', 30))}</text><text x="${p.x + 14}" y="${p.y + 74}" class="fd-gnode-meta">${n.usedBy.length ? `used by ${n.usedBy.length}` : 'nothing depends on it'}${tasks ? ` · ${plural(tasks, 'task')}` : ''}</text>${step ? `<circle cx="${p.x + W - 20}" cy="${p.y + 22}" r="12" class="fd-step"/><text x="${p.x + W - 20}" y="${p.y + 27}" text-anchor="middle" class="fd-step-n">${step}</text>` : ''}</g>`;
    }).join('');
    return `<svg viewBox="${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}" style="min-width:${Math.round(width * 0.9)}px;max-width:${width + pad * 2}px" class="fd-graph" role="group" aria-label="Project relationships"><defs><marker id="fd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#6f746e"/></marker><marker id="fd-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#c3aa7c"/></marker></defs>${edges}${nodes}</svg>`;
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
      return `<h2 class="fd-h1">${plural(g.nodes.length, 'project')} in this workspace</h2><p>Select a project to see what it is, what it depends on, who uses it, and what a change in it reaches.</p>${linked ? '' : `<div class="fd-next"><h3>No relationships declared yet</h3><p>Say which projects a project depends on in <code>repos.json</code>:</p><pre>"dependsOn": [{ "project": "theming", "label": "uses styles" }]</pre><p class="fd-caption"><code>factory doctor</code> suggests links it finds in package.json files.</p></div>`}${g.problems.length ? `<h3>Problems in the declared relationships</h3><ul class="fd-needs">${g.problems.map(p => `<li class="fd-fail">${escape(p)}</li>`).join('')}</ul>` : ''}${g.undeclared.length ? `<h3>Found in package.json, not declared</h3><ul class="fd-needs">${g.undeclared.map(l => `<li>${escape(l.from)} lists <code>${escape(l.package)}</code>, which ${escape(l.to)} publishes.</li>`).join('')}</ul>${served ? `<div class="fd-actions"><button class="fd-btn fd-primary" data-declare>Add these ${g.undeclared.length} relationships</button></div>` : ''}<p class="fd-caption fd-explain">This writes them to <code>dependsOn</code> in repos.json, so the map can draw them. A link that would make two projects depend on each other is left out. Remove one later by editing <code>dependsOn</code>.</p>` : ''}`;
    }
    const tasks = data.issues.filter(i => i.repo === n.key), project = data.projects.find(p => p.key === n.key);
    if (mapMode === 'reach') {
      const depth = Math.max(0, ...n.reach.map(r => r.depth)), path = [n.key, ...n.reach.map(r => r.key)];
      const along = data.issues.filter(i => path.includes(i.repo));
      return `<h2 class="fd-h1">What a change in ${escape(n.key)} reaches</h2>${n.reach.length ? `<p>Numbers show the order in which a change travels. A later step usually needs a release of the step before it.</p><ol class="fd-waves"><li><strong>${escape(n.key)}</strong><span class="fd-muted">Make the change here first.</span></li>${Array.from({ length: depth }, (_, d) => `<li><strong>${n.reach.filter(r => r.depth === d + 1).map(r => escape(r.key)).join(' · ')}</strong><span class="fd-muted">Take the new version, run this project's checks, and look at what users see.</span></li>`).join('')}</ol><p class="fd-caption">${g.nodes.length - path.length ? `Not reached: ${escape(names(g.nodes.filter(x => !path.includes(x.key)).map(x => x.key)))}.` : 'Every project in this workspace is reached.'}</p>` : '<p>Nothing in this workspace depends on this project, so a change here reaches no other project.</p>'}<h3>Open work along this path</h3>${along.map(miniTask).join('') || '<p class="fd-muted">None.</p>'}<div class="fd-actions fd-gap"><button class="fd-btn fd-primary" data-start="${escape(n.key)}">Start a task in ${escape(n.key)}</button><button class="fd-btn" data-mapmode="explore">Back to the map</button></div>`;
    }
    const pin = d => d.range ? ` · pins ${escape(d.range)}${d.version ? `, ${escape(d.to || d.key)} is at ${escape(d.version)}` : ''}` : '';
    return `<h2 class="fd-h1">${escape(n.key)}</h2><p>${n.description ? escape(n.description) : '<span class="fd-muted">No description yet. Add <code>description</code> to this project in repos.json so newcomers know what it is.</span>'}</p>${n.owns ? `<p class="fd-caption">Change here when: ${escape(n.owns)}</p>` : ''}<h3>Depends on</h3>${n.dependsOn.length ? `<ul class="fd-plain">${n.dependsOn.map(d => `<li>${nodeLink(d.key)}<span class="fd-muted">${d.label ? ` · ${escape(d.label)}` : ''}${pin(d)}</span></li>`).join('')}</ul>` : '<p class="fd-muted">Nothing in this workspace.</p>'}<h3>Used by</h3>${n.usedBy.length ? `<ul class="fd-plain">${n.usedBy.map(u => { const label = node(u).dependsOn.find(d => d.key === n.key).label; return `<li>${nodeLink(u)}<span class="fd-muted">${label ? ` · ${escape(label)}` : ''}</span></li>`; }).join('')}</ul>` : '<p class="fd-muted">Nothing in this workspace.</p>'}<div class="fd-next fd-gap"><h3>If you change this project</h3><p>${n.reach.length ? `The change reaches <strong>${plural(n.reach.length, 'project')}</strong>: ${escape(names(n.reach.map(r => r.key)))}. Plan to check them before release.` : 'No other project in this workspace is affected.'}</p>${n.reach.length ? '<button class="fd-btn" data-mapmode="reach">Show what a change reaches</button>' : ''}</div><h3>Tasks in flight</h3>${tasks.map(miniTask).join('') || '<p class="fd-muted">None.</p>'}<h3>How it is checked</h3><p>${project?.gates.length ? project.gates.map(x => `<code>${escape(x.cmd)}</code>`).join(' · ') : '<span class="fd-warning">No check configured.</span>'}</p><div class="fd-actions fd-gap"><button class="fd-btn fd-primary" data-start="${escape(n.key)}">Start a task here</button>${externalLink(`https://github.com/${n.remote}`, 'Open on GitHub')}</div>`;
  }
  function renderMap() {
    if (!data.graph?.nodes.length) { $('map').innerHTML = '<div class="fd-page"><h2 class="fd-h1">Workspace map</h2><p class="fd-desc">No projects are registered yet.</p><pre>factory add app /path/to/app --verify "npm run verify"</pre></div>'; return; }
    if (mapSel && !node(mapSel)) mapSel = null;
    const tracing = mapMode === 'reach' && mapSel;
    $('map').innerHTML = `<div class="fd-map"><div class="fd-canvas"><div class="fd-map-bar"><p class="fd-board-note">${tracing ? `Showing everything a change in <strong>${escape(mapSel)}</strong> reaches, in order.` : 'An arrow means: a change in the upper project reaches the lower one. Select a project to learn about it.'}</p><div class="fd-switch" role="group" aria-label="Map mode"><button data-mapmode="explore" aria-pressed="${mapMode === 'explore'}">Explore</button><button data-mapmode="reach" aria-pressed="${mapMode === 'reach'}">What a change reaches</button></div></div><div class="fd-graph-wrap">${graphSvg()}</div>${graphTree()}</div><aside class="fd-side" id="map-panel" tabindex="-1" aria-label="Project details">${mapPanel()}</aside></div>`;
  }
  function renderMetrics() {
    const m = data.metrics;
    if (!m || !m.tasks.length) { $('metrics').innerHTML = '<h2 class="fd-h1">Metrics</h2><p class="fd-desc">No implemented tasks are recorded yet. Measures appear once a task has run its checks.</p>'; return; }
    const s = m.summary, na = (value, show = String) => value === null ? '<span class="fd-muted">n/a</span>' : escape(show(value));
    const tile = (label, value, note) => `<div class="fd-tile"><span class="fd-energy-label">${label}</span><strong>${value}</strong><span class="fd-caption">${note}</span></div>`;
    $('metrics').innerHTML = '<h2 class="fd-h1">Metrics</h2><p class="fd-desc">How tasks went, derived from recorded evidence and stage history. Archived tasks are included; reviews of other people’s pull requests are not.</p>'
      + `<div class="fd-tiles">${tile('FIRST-PASS CHECK RATE', na(s.firstPassRate, v => `${Math.round(v * 100)}%`), `${number(s.firstPass)} of ${number(s.withGateRuns)} tasks passed every check on its first recorded run. ${number(s.tasks - s.withGateRuns)} without check runs are left out.`)}${tile('MEDIAN TIME TO APPROVAL', na(s.medianHoursToApproval, v => `${number(v, 1)} h`), `${number(s.approved)} approved task${s.approved === 1 ? '' : 's'}, from intake to approval.`)}${tile('REWORK', escape(number(s.failedGateRuns + s.verifierFails + s.resets)), `${number(s.failedGateRuns)} failed check runs · ${number(s.verifierFails)} verifier fail verdicts · ${number(s.resets)} resets after passing checks.`)}</div>`
      + `<div class="fd-table-wrap"><table class="fd-usage-table fd-metrics-table"><caption class="sr-only">Measures per task</caption><thead><tr>${['Task', 'Tier', 'Type', 'Step', 'First pass', 'Failed runs', 'Verifier fails', 'Resets', 'Hours to approval', 'New tokens'].map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${m.tasks.map(t => `<tr><th scope="row">${escape(t.id)}</th><td>${na(t.tier)}</td><td>${na(t.type)}</td><td>${escape(stepName(t.stage, t.id))}</td><td>${t.firstPass === null ? na(null) : `<span class="${t.firstPass ? 'fd-pass' : 'fd-fail'}">${t.firstPass ? 'yes' : 'no'}</span>`}</td><td>${number(t.failedGateRuns)}</td><td>${number(t.verifierFails)}</td><td>${number(t.resets)}</td><td>${na(t.hoursToApproval, v => number(v, 1))}</td><td>${na(t.freshTokens, v => compact(v) + (t.tokensPartial ? ' · partial' : ''))}</td></tr>`).join('')}</tbody></table></div>`
      + '<p class="fd-caption fd-explain">“n/a” means no data, not zero. These describe recorded work in this factory; they are not a productivity comparison.</p>';
  }
  function renderActivity() {
    const events = data.issues.flatMap(i => i.history.map(h => ({ ...h, task: i }))).sort((a, b) => b.at.localeCompare(a.at));
    const when = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
    $('activity').innerHTML = '<h2 class="fd-h1">Activity</h2><p class="fd-desc">Every step the tasks in flight have passed, newest first.</p>' + (events.map(h => `<div class="fd-project"><p><button class="fd-link" data-open-task="${escape(h.task.id)}">${escape(h.task.repo)} / ${h.task.kind === 'review' ? 'PR ' : ''}#${escape(h.task.issue)}</button> · <strong>${escape(h.task.steps?.find(x => x.stage === h.stage)?.title || h.stage)}</strong> <span class="fd-caption" title="${escape(h.at)}">${escape(when(h.at))}</span></p>${h.note ? `<p>${escape(h.note)}</p>` : ''}</div>`).join('') || '<p class="fd-blank">Nothing has happened yet. Start a task from GitHub issues.</p>');
  }
  function render() { renderQueue(); renderBoard(); applyQueueMode(); renderDetail(); renderMap(); renderProjects(); renderSettings(); renderActivity(); renderMetrics(); tick(); }
  // On a small screen the queue and the detail are separate screens.
  const showPane = (pane) => { document.body.dataset.pane = pane; };
  // Opens the confirm dialog with a button that names the action.
  function openAction(label = 'Confirm') { $('confirm-action').textContent = label; $('action-error').textContent = ''; $('action-dialog').showModal(); }
  // Writes the current place into the address as #view, #work/<task> or #work/<task>/<tab>.
  let hashReady = false, applying = false;
  let placed = false;
  function syncHash() {
    if (!hashReady || applying) return;
    const onTask = view === 'work' && queueMode === 'list' && selected;
    const next = `#${view}${onTask ? `/${encodeURIComponent(selected)}${tab ? `/${tab}` : ''}` : ''}`;
    // The first address replaces the entry the page loaded with; later ones add to the history.
    if (location.hash !== next) { history[placed ? 'pushState' : 'replaceState'](null, '', next); placed = true; }
  }
  // Opens what the address names; unknown parts are ignored.
  function applyHash(fromHistory = false) {
    const [name, id, part] = location.hash.slice(1).split('/').map(decodeURIComponent);
    if (!document.querySelector(`.fd-nav [data-view="${CSS.escape(name || '')}"]`)) return;
    applying = true;
    if (name === 'work' && id && data.issues.some(i => i.id === id)) { selected = id; tab = part || ''; queueMode = 'list'; }
    // "#work" alone is the board, or a list with no task open.
    else if (name === 'work' && !id && fromHistory && data.issues.length) queueMode = 'board';
    show(name);
    if (name === 'work') { renderQueue(); renderDetail(); }
    applying = false; placed = true;
  }
  addEventListener('hashchange', () => applyHash(true));
  const openTask = (id, to = '') => { selected = id; tab = to; scope = 'task'; show('work'); queueMode = 'list'; applyQueueMode(); renderQueue(); renderDetail(); showPane('detail'); $('detail').focus({ preventScroll: true }); syncHash(); };
  const pickNode = (key, from) => { mapSel = key; renderMap(); (from === 'panel' ? $('map-panel') : document.querySelector(`#map ${from === 'tree' ? '.fd-leaf' : '.fd-gnode'}[data-node="${CSS.escape(key)}"]`))?.focus({ preventScroll: true }); };
  $('map').onclick = e => {
    if (e.target.closest('[data-declare]')) {
      post('/api/graph/declare', {}).then(r => { notice(`${r.added.length} relationship(s) added.${r.skipped.length ? ` Left out, because the other direction is already declared: ${r.skipped.join(', ')}.` : ''}`); refresh(); }, error => notice(error.message, true));
      return;
    }
    const modeButton = e.target.closest('[data-mapmode]');
    if (modeButton) { mapMode = modeButton.dataset.mapmode; if (mapMode === 'reach' && !mapSel) mapSel = data.graph.nodes.find(n => !n.dependsOn.length && n.usedBy.length)?.key || data.graph.nodes[0].key; renderMap(); document.querySelector(`#map .fd-switch [data-mapmode="${mapMode}"]`)?.focus(); return; }
    const open = e.target.closest('[data-open-task]'); if (open) return openTask(open.dataset.openTask);
    const start = e.target.closest('[data-start]'); if (start) return openNew(start.dataset.start);
    const picked = e.target.closest('[data-node]');
    if (picked) pickNode(picked.dataset.node, picked.classList.contains('fd-leaf') ? 'tree' : picked.classList.contains('fd-textlink') ? 'panel' : 'graph');
  };
  $('map').onkeydown = e => { const picked = e.target.closest?.('.fd-gnode'); if (picked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickNode(picked.dataset.node, 'graph'); } };
  $('kanban').onclick = e => {
    const card = e.target.closest('[data-peek]'); if (!card) return;
    peek = card.dataset.peek; renderBoard(); showPane('detail'); $('drawer').focus({ preventScroll: true });
  };
  $('drawer').onkeydown = e => { if (e.key === 'Escape') $('drawer').querySelector('[data-close]')?.click(); };
  $('drawer').onclick = e => {
    if (e.target.closest('[data-close]')) { const id = peek; peek = null; renderBoard(); document.querySelector(`[data-peek="${CSS.escape(id)}"]`)?.focus(); return; }
    const open = e.target.closest('[data-open]'); if (open) return openTask(peek, open.dataset.open);
    // The drawer shows the same panel as the task page, so its buttons take the same path.
    if (e.target.closest('[data-action], [data-unblock], [data-post-questions], [data-create-pr], [data-post-review], [data-copy-doc], [data-copy-prompt], [data-run-agent], [data-stop-agent], .fd-now a.fd-btn, [data-tab]')) { selected = peek; const twin = e.target.closest('[data-tab]'); if (twin) return openTask(peek, twin.dataset.tab); $('detail').dispatchEvent(new CustomEvent('fd-act', { detail: e.target })); }
  };
  $('detail').addEventListener('toggle', e => { if (e.target.open && e.target.dataset?.log) loadLog(e.target); }, true);
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => show(button.dataset.view));
  $('search').oninput = e => { query = e.target.value; renderQueue(); };
  $('tasks').onclick = e => { const button = e.target.closest('[data-task]'); if (button) { selected = button.dataset.task; scope = 'task'; tab = ''; renderQueue(); renderDetail(); showPane('detail'); syncHash(); } };
  $('detail').addEventListener('fd-act', e => detailClick({ target: e.detail }));
  $('detail').onclick = e => detailClick(e);
  function detailClick(e) {
    if (e.target.closest('[data-back]')) { showPane('list'); if (peek) { queueMode = 'board'; applyQueueMode(); } return; }
    const onMap = e.target.closest('[data-show-map]');
    if (onMap) { mapSel = onMap.dataset.showMap; mapMode = 'reach'; show('map'); renderMap(); $('map-panel').focus({ preventScroll: true }); return; }
    const button = e.target.closest('[data-tab]');
    if (button) { tab = button.dataset.tab; renderDetail(); syncHash(); }
    const unblock = e.target.closest('[data-unblock]'), copyDoc = e.target.closest('[data-copy-doc]');
    if (copyDoc) navigator.clipboard.writeText(task().docs[copyDoc.dataset.copyDoc] || '').then(() => notice('Copied.'), () => notice('Clipboard unavailable. Select the text and copy it.'));
    if (unblock) {
      const i = task(), mode = unblock.dataset.unblock;
      pending = { id: i.id };
      $('answer-form').reset(); $('answer-error').textContent = '';
      $('answer-title').textContent = mode === 'answer' ? 'Answer the agent' : mode === 'skip' ? 'Continue without answering?' : 'Resume this task';
      $('answer-text').textContent = mode === 'answer' ? 'Write your answers. The agent reads them, updates its triage, and either starts or comes back with what is still open.' : mode === 'skip' ? 'The agent is told the issue is clear enough, to use its best reading, and to state its assumptions in the plan. Add a note if you want to steer it.' : 'The task continues where it stopped and its failed attempts are counted from zero. Add a hint for the agent if you have one.';
      $('answer-form').elements.note.required = mode === 'answer';
      $('answer-label').textContent = mode === 'answer' ? 'Your answer' : 'Note for the agent (optional)';
      $('answer-dialog').showModal(); $('answer-form').elements.note.focus();
    }
    if (e.target.closest('[data-create-pr]')) {
      const i = task();
      pending = { id: i.id };
      $('pr-create-form').reset(); $('pr-create-error').textContent = '';
      $('pr-create-form').elements.title.value = i.prTitle || i.title;
      $('pr-text').textContent = `${i.repo} #${i.issue}: this pushes the branch ${i.branch} at commit ${(i.head || '').slice(0, 12)} and opens a pull request into ${i.base}. It is the version you approved. It becomes public on GitHub at once.`;
      // Starts from the people chosen for this project last time; without a memory, you are the assignee.
      let last = null;
      try { last = JSON.parse(localStorage.getItem(`factory-pr-${i.repo}`)); } catch { /* No remembered choice. */ }
      picked = { reviewers: last?.reviewers || [], assignees: last?.assignees || ['@me'] };
      for (const radio of $('pr-create-form').elements.draft) radio.checked = radio.value === (last?.draft ? '1' : '');
      $('pr-people').innerHTML = ''; $('pr-people-note').textContent = 'Loading who can review…';
      drawPicked();
      fetch(`/api/people?project=${encodeURIComponent(i.repo)}`).then(r => r.json()).then(result => {
        const others = (result.people || []).filter(login => login !== result.me);
        $('pr-people').innerHTML = others.map(login => `<option value="${escape(login)}">`).join('') + '<option value="@me">';
        $('pr-people-note').textContent = others.length ? `${others.length} people can review or be assigned in this repository. "@me" is you${result.me ? ` (${result.me})` : ''}. You cannot review your own pull request.` : 'GitHub did not return the list of people. You can still type a login.';
      }, () => { $('pr-people-note').textContent = 'The list of people could not be loaded. You can still type a login.'; });
      $('pr-dialog').showModal(); $('pr-create-form').elements.title.focus();
    }
    if (e.target.closest('[data-post-review]')) {
      const i = task();
      pending = { path: '/api/review/post', body: { id: i.id }, done: `${i.id}: review posted.` };
      $('action-title').textContent = 'Post this review on GitHub?';
      $('action-text').textContent = `The approved draft is posted on ${i.repo} PR #${i.issue} with its verdict, under your GitHub name. Everyone who follows the pull request sees it.`;
      openAction('Post the review');
    }
    if (e.target.closest('[data-post-questions]')) {
      const i = task();
      pending = { path: '/api/questions/post', body: { id: i.id, sha: i.questionsSha }, done: `${i.id}: questions posted on the issue.` };
      $('action-title').textContent = 'Post these questions on GitHub?';
      $('action-text').textContent = `The text shown on the page is posted as a comment on ${i.repo} #${i.issue}, under your GitHub name. Everyone who follows the issue sees it. The task keeps waiting until you put the answer here.`;
      openAction('Post the questions');
    }
    const agentButton = e.target.closest('[data-run-agent], [data-stop-agent]');
    if (agentButton) {
      const i = task(), stop = agentButton.hasAttribute('data-stop-agent');
      agentButton.disabled = true;
      post(stop ? '/api/agent/stop' : '/api/agent/run', { id: i.id }).then(result => { notice(stop ? `${i.id}: the agent is stopping.` : result.status === 'queued' ? `${i.id}: waiting for a free slot.` : `${i.id}: the agent started. This page follows it.`); refresh(); }, error => { notice(error.message, true); agentButton.disabled = false; });
    }
    if (e.target.closest('.fd-now a.fd-btn:not([data-agent-log])')) { launched[task().id] = Date.now(); setTimeout(renderDetail, 300); }
    if (e.target.closest('[data-copy-prompt]')) {
      navigator.clipboard.writeText(task().prompt).then(() => notice('Prompt copied. Paste it into your agent.'), () => notice('Clipboard unavailable. Run "factory next" for this task in your agent instead.'));
    }
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
      openAction(!approving ? 'Archive task' : i.kind === 'review' ? 'Approve this draft' : `Approve commit ${(i.head || '').slice(0, 12)}`);
    }
  };
  for (const host of ['detail', 'drawer']) $(host).addEventListener('submit', async e => {
    if (e.target.id !== 'pr-form') return;
    e.preventDefault();
    const id = host === 'drawer' ? peek : selected;
    try { await post('/api/pr', { id, url: e.target.elements.url.value }); notice(`${id}: pull request recorded.`); refresh(); }
    catch (error) { e.target.parentElement.querySelector('#pr-error').textContent = error.message; }
  });
  // The reviewers and assignees chosen in the pull request dialog.
  let picked = { reviewers: [], assignees: [] };
  function drawPicked() {
    for (const box of document.querySelectorAll('#pr-dialog [data-people]')) {
      const list = picked[box.dataset.people];
      box.querySelector('.fd-picked').innerHTML = list.map(login => `<li><span class="fd-chip">${escape(login)}</span><button type="button" class="fd-link" data-drop-person="${escape(login)}" aria-label="Remove ${escape(login)}">Remove</button></li>`).join('') || '<li class="fd-caption">Nobody</li>';
    }
  }
  function addPerson(input) {
    const login = input.value.trim().replace(/^@(?!me$)/, ''), list = picked[input.closest('[data-people]').dataset.people];
    if (login && !list.includes(login)) list.push(login);
    input.value = ''; drawPicked();
  }
  $('pr-dialog').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-person]')) { e.preventDefault(); addPerson(e.target); } });
  // Choosing a suggestion fills the field in one step, which a typed character never does.
  $('pr-dialog').addEventListener('input', e => { if (e.target.matches('[data-person]') && [...$('pr-people').options].some(o => o.value === e.target.value) && e.inputType !== 'insertText') addPerson(e.target); });
  $('pr-dialog').addEventListener('click', e => {
    const drop = e.target.closest('[data-drop-person]');
    if (drop) { const key = drop.closest('[data-people]').dataset.people; picked[key] = picked[key].filter(login => login !== drop.dataset.dropPerson); drawPicked(); }
  });
  $('cancel-pr').onclick = () => $('pr-dialog').close();
  $('pr-create-form').onsubmit = async e => {
    e.preventDefault();
    const form = e.target;
    $('confirm-pr').disabled = true; $('confirm-pr').textContent = 'Pushing and creating…'; $('pr-create-error').textContent = '';
    try {
      // A login still sitting in a field counts as chosen.
      for (const input of form.querySelectorAll('[data-person]')) if (input.value.trim()) addPerson(input);
      const draft = form.elements.draft.value === '1';
      const result = await post('/api/pr/create', { id: pending.id, title: form.elements.title.value, draft, reviewers: picked.reviewers, assignees: picked.assignees });
      try { localStorage.setItem(`factory-pr-${task()?.repo}`, JSON.stringify({ draft, ...picked })); } catch { /* The choice is not remembered. */ }
      notice(`${pending.id}: pull request created.`, false, { url: result.url, text: 'Open the pull request' });
      $('pr-dialog').close(); pending = null; refresh();
    } catch (error) { $('pr-create-error').textContent = error.message; }
    finally { $('confirm-pr').disabled = false; $('confirm-pr').textContent = 'Push and create'; }
  };
  $('cancel-answer').onclick = () => $('answer-dialog').close();
  $('answer-form').onsubmit = async e => {
    e.preventDefault();
    $('confirm-answer').disabled = true;
    try {
      await post('/api/unblock', { id: pending.id, note: e.target.elements.note.value });
      notice(`${pending.id}: the task continues. Start the agent to carry on.`);
      $('answer-dialog').close(); pending = null; refresh();
    } catch (error) { $('answer-error').textContent = error.message; }
    finally { $('confirm-answer').disabled = false; }
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
      if (request.run) { $('action-dialog').close(); pending = null; await request.run(); return; }
      await post(request.path, request.body);
      notice(request.done);
      $('action-dialog').close(); pending = null; gh = null; refresh(); loadSetup();
    } catch (error) { $('action-error').textContent = error.message; }
    finally { $('confirm-action').disabled = false; }
  };
  function newCommand() {
    const project = $('new-project').value, n = $('new-number').value;
    const valid = /^[1-9]\d*$/.test(n) && project;
    $('new-command').textContent = valid ? `factory ${$('new-kind').value} '${project}#${n}'` : 'Choose a project and enter a number.';
    $('copy-command').disabled = !valid; $('start-task').disabled = !valid || !served;
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
  $('new-filter').oninput = e => { const q = e.target.value.toLowerCase(); for (const b of document.querySelectorAll('#new-choices [data-choice]')) b.hidden = !b.textContent.toLowerCase().includes(q); };
  $('new-choices').onclick = e => { const choice = e.target.closest('[data-choice]'); if (choice) chooseProject(choice.dataset.choice); };
  function openNew(project, number) {
    $('new-project').innerHTML = data.projects.map(p => `<option value="${escape(p.key)}" ${p.key === project ? 'selected' : ''}>${escape(p.key)}</option>`).join('');
    $('new-choices').innerHTML = data.projects.map(p => `<button type="button" class="fd-choice" role="radio" aria-checked="false" data-choice="${escape(p.key)}"><strong>${escape(p.key)}</strong><small>${escape(p.owns || p.description || p.remote)}</small></button>`).join('') || '<p class="fd-warning">No projects are registered yet. Register one on the Projects page first.</p>';
    $('new-filter').value = '';
    if (data.projects.length) chooseProject(data.projects.some(p => p.key === project) ? project : $('new-project').value);
    if (number) { $('new-kind').value = 'new'; $('new-number').value = number; }
    $('new-error').textContent = ''; newCommand(); $('new-dialog').showModal();
  }
  $('new-task').onclick = () => openNew(mapSel);
  $('start-task').onclick = async () => {
    const project = $('new-project').value, number = Number($('new-number').value), kind = $('new-kind').value;
    $('start-task').disabled = true; $('start-task').textContent = 'Starting…'; $('new-error').textContent = '';
    try {
      const result = await post('/api/task/start', { project, number, kind });
      $('new-dialog').close(); selected = result.id; tab = ''; show('work'); refresh();
      notice(`${result.id}: started. Its branch and worktree are ready.`);
    } catch (error) { $('new-error').textContent = error.message; }
    finally { $('start-task').textContent = 'Start task'; newCommand(); }
  };
  ['new-project', 'new-kind', 'new-number'].forEach(id => $(id).oninput = newCommand);
  $('copy-command').onclick = async () => {
    try { await navigator.clipboard.writeText($('new-command').textContent); notice('Task command copied. Run it in your terminal.'); }
    catch { notice('Clipboard unavailable. Select and copy the command shown in the dialog.'); }
  };
  // The server could not build the board data, for example because repos.json is damaged.
  window.__factoryError = message => { lost = false; notice(`The board data could not be loaded: ${message}`, true); if (served) $('connection').textContent = 'Connected · data unavailable'; };
  window.__factoryData = next => {
    lost = false; if (!served) $('connection').textContent = 'Static snapshot';
    if (next.stamp === data.stamp) return;
    // Keep drafts and open explanations stable while the user interacts.
    if (data.stamp && (document.querySelector('dialog[open], #detail .fd-body details[open]:not(.fd-keep)') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName))) { paused = true; tick(); return; }
    paused = false;
    data = next;
    if (!data.issues.some(i => i.id === peek)) peek = null;
    // Opens on the task that waits for the user, when there is one.
    if (!data.issues.some(i => i.id === selected)) selected = (data.issues.find(i => i.stage === 'ready' && !i.blocked) || data.issues.find(needsYou) || data.issues[0])?.id || null;
    const skipped = data.skipped || [];
    if (skipped.length) notice(`${skipped.length} task${skipped.length === 1 ? '' : 's'} could not be shown. ${skipped.map(x => `${x.id}: ${x.reason}`).join(' ')}`, true);
    $('updated').textContent = `Loaded ${new Date().toLocaleTimeString()}`;
    // A redraw replaces the focused element; the one that stands for the same thing gets focus back.
    const held = document.activeElement, holder = held?.closest?.('section[id], aside[id], article[id]');
    const key = held && holder && ['task', 'peek', 'tab', 'node', 'edit', 'mode', 'openTask', 'action', 'unblock', 'createPr', 'postReview', 'open'].find(k => held.dataset?.[k] !== undefined);
    render();
    if (key && !document.contains(held)) holder.querySelector(`[data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${CSS.escape(held.dataset[key])}"]`)?.focus({ preventScroll: true });
    if (!hashReady) { hashReady = true; if (location.hash.length > 1) applyHash(); else syncHash(); }
    if (view === 'github') { if (gh) loadGithub(); else renderGithub(); }
    if (view === 'workflow' && !workflow.busy()) workflow.open();
  };
  addEventListener('focusout', () => { if (paused) setTimeout(refresh, 0); });
  $('detail').addEventListener('toggle', () => { if (paused) refresh(); }, true);
  for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => { if (paused) refresh(); });
  function refresh() {
    const script = document.createElement('script'); script.src = `board-data.js?t=${Date.now()}`;
    script.onload = () => script.remove();
    script.onerror = () => { script.remove(); lost = true; tick(); };
    document.body.appendChild(script);
  }
  // Asks in the app's own dialog; "run" happens only on Confirm.
  const ask = (title, text, run) => { pending = { run }; $('action-title').textContent = title; $('action-text').textContent = text; openAction(); };
  const workflow = mountWorkflow({ $, escape, post, served, notice, ask, projects: () => data.projects });
  $('open-help').onclick = () => $('help-dialog').showModal();
  $('activity').onclick = e => { const open = e.target.closest('[data-open-task]'); if (open) openTask(open.dataset.openTask); };
  // Single keys for the frequent moves; they stay out of the way while typing or while a dialog is open, and can be switched off.
  let keysOn = true;
  try { keysOn = localStorage.getItem('factory-keys') !== 'off'; } catch { /* Shortcuts stay on when storage is unavailable. */ }
  $('keys-on').checked = keysOn;
  $('keys-on').onchange = e => { keysOn = e.target.checked; try { localStorage.setItem('factory-keys', keysOn ? 'on' : 'off'); } catch { /* The choice lasts for this visit only. */ } };
  addEventListener('keydown', e => {
    if (!keysOn || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    const onBoard = view === 'work' && queueMode === 'board';
    const move = step => {
      if (!data.issues.length) return;
      // On the board the cards are walked in column order and the side panel follows.
      const order = onBoard ? COLUMNS.flatMap(([key]) => data.issues.filter(i => columnOf(i) === key)) : data.issues;
      const next = order[(order.findIndex(i => i.id === (onBoard ? peek : selected)) + step + order.length) % order.length].id;
      if (onBoard) { peek = next; renderBoard(); document.querySelector(`[data-peek="${CSS.escape(next)}"]`)?.focus(); } else openTask(next);
    };
    const keys = {
      '?': () => $('help-dialog').showModal(),
      n: () => openNew(),
      j: () => move(1),
      k: () => move(-1),
      b: () => { show('work'); queueMode = 'board'; applyQueueMode(); syncHash(); },
      l: () => { show('work'); queueMode = 'list'; applyQueueMode(); syncHash(); },
      '/': () => { const box = { github: 'gh-search', projects: 'project-search' }[view]; if (box) return $(box)?.focus(); show('work'); queueMode = 'list'; applyQueueMode(); $('search').focus(); },
      a: () => document.querySelector('#work:not([hidden]) [data-action=approve]')?.click(),
      r: () => document.querySelector('#work:not([hidden]) [data-action=reject]')?.click(),
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });
  renderGithub();
  applyQueueMode();
  setInterval(tick, 5000);
  if (served) {
    // The server announces changes to task data; the slower poll also catches commits in the worktrees.
    setInterval(refresh, 10000);
    if (window.EventSource) new EventSource('/api/events').addEventListener('change', refresh);
    loadSetup();
  }
})();
