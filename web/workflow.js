// Draws the Workflow page: pipeline, stage editor, agent preview and repository proposals.
function mountWorkflow({ $, escape, post, served, notice, projects }) {
  const el = $('workflow');
  const HEAD = '<div><h1>Workflow</h1><p class="fd-desc">What the agent is told at each stage, which skills and agents it uses, and which checks apply to which type of task. Approval by you, evidence integrity and the clean-tree rule are fixed.</p></div>';
  const LABELS = { skipFor: { reproduce: 'Skip this stage for', plan: 'Skip this stage for', verify: 'No verifier needed for' }, requireRegression: 'Regression proof required for' };
  let scope = 'global', pipeline = 'stages', stage = 'triage', info = null, draft = {}, previewType = '', loading = false;

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const dirty = () => info && !same(draft, info.override);
  const inherited = (p = pipeline, s = stage) => info.inherited[p][s];
  const effective = (p = pipeline, s = stage) => ({ ...inherited(p, s), ...draft[p]?.[s] });
  const types = () => draft.types || info.inherited.types;
  const lines = (text) => [...new Set(text.split('\n').map(line => line.trim()).filter(Boolean))];

  async function load() {
    if (!served) return render();
    loading = true;
    try {
      const response = await fetch(`/api/workflow?scope=${encodeURIComponent(scope)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load the workflow.');
      info = result; draft = structuredClone(result.override);
    } catch (error) { notice(error.message); }
    loading = false;
    render();
  }

  const typeChips = (field, selected) => `<div class="fd-chips fd-typechips" data-types="${field}">${types().map(type => `<button type="button" class="fd-chip-btn" data-type="${escape(type)}" aria-pressed="${selected.includes(type)}">${escape(type)}</button>`).join('')}</div>`;
  const useRow = (entry = { ref: '', kind: 'skill', types: [] }) => `<div class="fd-use"><label>Skill, agent, or file in the project<input data-use="ref" list="wf-refs" value="${escape(entry.ref)}" placeholder="code-review or .github/agents/implementer.md"></label><label>Kind<select data-use="kind"><option value="skill" ${entry.kind === 'skill' ? 'selected' : ''}>Skill</option><option value="agent" ${entry.kind === 'agent' ? 'selected' : ''}>Agent</option></select></label><button type="button" class="fd-btn fd-ghost" data-drop-use>Remove</button><div class="fd-use-types"><span class="fd-caption">Only for these types (none selected means every type)</span>${typeChips('use', entry.types || [])}</div></div>`;

  function nodes(name) {
    return `<ol class="fd-pipe">${info.shape[name].map(({ stage: s, configurable }) => {
      const value = effective(name, s), set = Boolean(draft[name]?.[s]);
      const meta = [value.use.length ? `${value.use.length} in use` : '', value.skipFor?.length ? `${s === 'verify' ? 'no verifier' : 'skips'}: ${value.skipFor.join(', ')}` : '', configurable ? '' : 'fixed rule'].filter(Boolean);
      return `<li><button type="button" class="fd-node" data-node="${name}:${escape(s)}" aria-pressed="${name === pipeline && s === stage}"><span class="fd-node-name">${escape(s)}${set ? '<span class="fd-node-dot" title="Changed in this scope"></span>' : ''}</span><span class="fd-node-meta">${escape(meta.join(' · ') || 'default')}</span></button></li>`;
    }).join('')}</ol>`;
  }

  function editor() {
    const shape = info.shape[pipeline].find(item => item.stage === stage), value = effective();
    const has = field => shape.fields.includes(field);
    const chips = field => `<fieldset class="fd-field"><legend>${field === 'skipFor' ? LABELS.skipFor[stage] : LABELS[field]}</legend>${typeChips(field, value[field] || [])}</fieldset>`;
    return `<form id="wf-form" class="fd-panel"><header class="fd-editor-head"><h2>${escape(pipeline === 'review' ? `review · ${stage}` : stage)}</h2><span class="fd-badge">${shape.configurable ? 'checks configurable' : 'fixed exit rule'}</span></header><p class="fd-caption fd-rule">Exit rule: ${escape(shape.rule)}</p><label>Instructions for the agent<textarea name="instructions" rows="7">${escape(value.instructions)}</textarea></label><p class="fd-caption">Placeholders: <code>{id}</code> <code>{dir}</code> (the task's document folder) <code>{worktree}</code> <code>{types}</code> <code>{headings}</code></p><fieldset class="fd-field"><legend>Skills and agents to use</legend><div id="wf-use">${value.use.map(useRow).join('')}</div><button type="button" class="fd-btn" id="wf-add-use">+ Add</button></fieldset><label>Model hint<input name="model" value="${escape(value.model)}" placeholder="Leave empty to use the session's model"></label>${has('skipFor') ? chips('skipFor') : ''}${has('headings') ? `<label>Required sections in plan.md, one per line<textarea name="headings" rows="4">${escape((value.headings || []).join('\n'))}</textarea></label>` : ''}${has('requireRegression') ? chips('requireRegression') : ''}${has('rerunGates') ? `<label class="fd-check"><input type="checkbox" name="rerunGates" ${value.rerunGates ? 'checked' : ''}><span>The verifier re-runs every gate</span></label>` : ''}<p id="wf-error" role="alert"></p><div class="fd-actions"><button type="submit" class="fd-btn fd-primary">Save workflow</button><button type="button" class="fd-btn fd-ghost" id="wf-reset">Reset this stage</button><span class="fd-caption" id="wf-dirty"></span></div></form>`;
  }

  function general() {
    return `<details class="fd-panel fd-general"><summary>For every stage${draft.readFirst || draft.types ? ' · changed in this scope' : ''}</summary><label>Files the agent reads first, one per line, relative to the project<textarea id="wf-read-first" rows="2" placeholder="AGENTS.md">${escape((draft.readFirst || info.inherited.readFirst).join('\n'))}</textarea></label><label>Task types, one per line<textarea id="wf-types" rows="4">${escape(types().join('\n'))}</textarea></label><p class="fd-caption">Triage assigns one of these types. Type-based checks refer to them. Saved with "Save workflow".</p></details>`;
  }

  function found() {
    if (scope === 'global' || !info.assets) return '';
    const a = info.assets, count = a.agents.length + a.skills.length + a.products.length + a.instructions.length + (a.prTemplate ? 1 : 0);
    if (!count) return '<p class="fd-blank">This repository has no agent, skill or instruction files the factory recognizes.</p>';
    const proposals = info.proposals.length ? `<div class="fd-proposals"><div class="fd-editor-head"><h3>Proposals from this repository <span class="fd-muted">${info.proposals.length}</span></h3><button type="button" class="fd-btn" id="wf-accept-all">Accept all</button></div><ul class="fd-issues">${info.proposals.map(p => `<li class="fd-issue"><div><p class="fd-issue-title">${escape(p.title)}</p><p class="fd-issue-meta"><span>${escape(p.reason)}</span></p>${p.note ? `<p class="fd-issue-meta fd-warning">${escape(p.note)}</p>` : ''}</div><div class="fd-issue-action"><button type="button" class="fd-btn" data-accept="${escape(p.id)}">Accept</button><button type="button" class="fd-btn fd-ghost" data-dismiss="${escape(p.id)}">Dismiss</button></div></li>`).join('')}</ul></div>` : '<p class="fd-caption">No open proposals for this project.</p>';
    const group = (title, items) => items.length ? `<h4>${title} <span class="fd-muted">${items.length}</span></h4><ul class="fd-asset-list">${items.map(i => `<li><span class="fd-chip">${escape(i.name)}</span>${i.differs ? '<span class="fd-badge fd-badge-warn">copies differ</span>' : ''}<code>${escape(i.path)}</code>${i.description ? `<span class="fd-asset-desc">${escape(i.description)}</span>` : ''}</li>`).join('')}</ul>` : '';
    return `<h2 class="fd-section">Found in this repository <span>${count}</span></h2>${proposals}<details class="fd-panel fd-general"><summary>Everything found</summary>${group('Agents', a.agents)}${group('Contributor skills', a.skills)}${group('Product skills, written for library users and not proposed', a.products)}<h4>Instruction files</h4><p class="fd-caption">${escape(a.instructions.join(', ') || 'none')}</p><h4>PR template</h4><p class="fd-caption">${escape(a.prTemplate || 'none')}</p></details>`;
  }

  function render() {
    if (!served) { el.innerHTML = `<header class="fd-page-head">${HEAD}</header><p class="fd-blank">This view needs the local server. Run <code>factory board</code>.</p>`; return; }
    if (!info) { el.innerHTML = `<header class="fd-page-head">${HEAD}</header><p class="fd-blank">${loading ? 'Loading the workflow…' : 'The workflow could not be loaded.'}</p>`; return; }
    if (!info.shape[pipeline].some(item => item.stage === stage)) { pipeline = 'stages'; stage = 'triage'; }
    const option = (value, label) => `<option value="${escape(value)}" ${value === scope ? 'selected' : ''}>${escape(label)}</option>`;
    const refs = [...(info.assets ? [...info.assets.agents, ...info.assets.skills].map(a => a.ref) : []), ...info.user.skills, ...info.user.agents];
    el.innerHTML = `<header class="fd-page-head">${HEAD}<label class="fd-scope">Applies to<select id="wf-scope">${option('global', 'All projects')}${projects().map(p => option(p.key, p.key)).join('')}</select></label></header><p class="fd-caption fd-scope-note">${scope === 'global' ? 'Changes here apply to every project that does not override them.' : `Changes here apply to ${escape(scope)} only. Everything else follows "All projects".`}</p><h2 class="fd-section">Issue to pull request</h2>${nodes('stages')}<h2 class="fd-section">Pull request review</h2>${nodes('review')}<div class="fd-wf-grid">${editor()}<aside class="fd-panel fd-preview"><div class="fd-editor-head"><h3>What the agent sees</h3><label class="fd-inline">Task type<select id="wf-preview-type"><option value="">not set</option>${types().map(t => `<option ${t === previewType ? 'selected' : ''}>${escape(t)}</option>`).join('')}</select></label></div><pre id="wf-preview">Loading…</pre><p class="fd-caption">Printed by <code>factory next &lt;id&gt;</code>. Shows the saved workflow, without unsaved changes.</p></aside></div>${general()}${found()}<datalist id="wf-refs">${[...new Set(refs)].map(r => `<option value="${escape(r)}">`).join('')}</datalist>`;
    mark();
    preview();
  }

  async function preview() {
    const target = `${scope}|${pipeline}|${stage}|${previewType}`;
    try {
      const response = await fetch(`/api/workflow/preview?scope=${encodeURIComponent(scope)}&pipeline=${pipeline}&stage=${encodeURIComponent(stage)}&type=${encodeURIComponent(previewType)}`);
      const result = await response.json();
      if (target !== `${scope}|${pipeline}|${stage}|${previewType}` || !$('wf-preview')) return;
      $('wf-preview').textContent = response.ok ? result.text : result.error;
    } catch (error) { if ($('wf-preview')) $('wf-preview').textContent = error.message; }
  }

  const mark = () => { if ($('wf-dirty')) $('wf-dirty').textContent = dirty() ? 'Unsaved changes' : ''; };
  const pressed = container => [...container.querySelectorAll('[aria-pressed=true]')].map(button => button.dataset.type);

  // Moves the form into the draft; a value equal to the inherited one is not stored.
  function collect() {
    const form = $('wf-form');
    if (!form || !info) return;
    const shape = info.shape[pipeline].find(item => item.stage === stage), base = inherited(), current = {};
    current.instructions = form.elements.instructions.value.trim();
    current.model = form.elements.model.value.trim();
    current.use = [...form.querySelectorAll('.fd-use')].map(row => {
      const only = pressed(row.querySelector('[data-types]'));
      return { ref: row.querySelector('[data-use=ref]').value.trim(), kind: row.querySelector('[data-use=kind]').value, ...(only.length ? { types: only } : {}) };
    }).filter(entry => entry.ref);
    for (const field of ['skipFor', 'requireRegression']) if (shape.fields.includes(field)) current[field] = pressed(form.querySelector(`[data-types=${field}]`));
    if (shape.fields.includes('headings')) current.headings = lines(form.elements.headings.value);
    if (shape.fields.includes('rerunGates')) current.rerunGates = form.elements.rerunGates.checked;
    const changed = Object.fromEntries(Object.entries(current).filter(([field, value]) => !same(value, base[field])));
    draft[pipeline] = { ...draft[pipeline] };
    if (Object.keys(changed).length) draft[pipeline][stage] = changed; else delete draft[pipeline][stage];
    if (!Object.keys(draft[pipeline]).length) delete draft[pipeline];
    const readFirst = lines($('wf-read-first').value), taskTypes = lines($('wf-types').value);
    if (same(readFirst, info.inherited.readFirst)) delete draft.readFirst; else draft.readFirst = readFirst;
    if (same(taskTypes, info.inherited.types)) delete draft.types; else draft.types = taskTypes;
  }

  async function act(pathname, body, done) {
    try { await post(pathname, body); notice(done); await load(); }
    catch (error) { if ($('wf-error')) $('wf-error').textContent = error.message; else notice(error.message); }
  }

  el.addEventListener('click', e => {
    const node = e.target.closest('[data-node]'), type = e.target.closest('[data-type]');
    if (type) { type.setAttribute('aria-pressed', type.getAttribute('aria-pressed') !== 'true'); collect(); mark(); return; }
    if (node) { collect(); [pipeline, stage] = node.dataset.node.split(':'); render(); el.querySelector('#wf-form textarea')?.focus({ preventScroll: true }); return; }
    if (e.target.id === 'wf-add-use') { $('wf-use').insertAdjacentHTML('beforeend', useRow()); $('wf-use').lastElementChild.querySelector('input').focus(); }
    if (e.target.closest('[data-drop-use]')) { e.target.closest('.fd-use').remove(); collect(); mark(); }
    if (e.target.id === 'wf-reset') { if (draft[pipeline]) delete draft[pipeline][stage]; render(); }
    if (e.target.id === 'wf-accept-all') act('/api/workflow/accept', { project: scope, ids: info.proposals.map(p => p.id) }, `${scope}: ${info.proposals.length} proposal(s) applied.`);
    if (e.target.dataset.accept) act('/api/workflow/accept', { project: scope, ids: [e.target.dataset.accept] }, `${scope}: proposal applied.`);
    if (e.target.dataset.dismiss) act('/api/workflow/dismiss', { project: scope, ids: [e.target.dataset.dismiss] }, `${scope}: proposal dismissed.`);
  });
  el.addEventListener('input', e => { if (e.target.closest('#wf-form, .fd-general')) { collect(); mark(); } });
  el.addEventListener('change', e => {
    if (e.target.id === 'wf-scope') {
      if (dirty() && !confirm('Discard the unsaved workflow changes?')) { e.target.value = scope; return; }
      scope = e.target.value; info = null; load();
    }
    if (e.target.id === 'wf-preview-type') { previewType = e.target.value; preview(); }
    // Picking a known asset sets its kind.
    if (e.target.dataset.use === 'ref' && info.assets) {
      const known = [...info.assets.agents, ...info.assets.skills].find(a => a.ref === e.target.value.trim());
      if (known) { e.target.closest('.fd-use').querySelector('[data-use=kind]').value = known.kind; collect(); mark(); }
    }
  });
  el.addEventListener('submit', e => {
    e.preventDefault();
    collect();
    act('/api/workflow', { scope, workflow: draft }, `Workflow saved for ${scope === 'global' ? 'all projects' : scope}.`);
  });

  return {
    open() { if (!info && !loading) load(); else render(); },
    // True while edits would be lost by a redraw.
    busy: () => dirty(),
  };
}
