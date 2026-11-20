// Draws the Workflow page: pipeline, stage editor, live agent preview and repository suggestions.
function mountWorkflow({ $, escape, post, served, notice, projects }) {
  const el = $('workflow');
  const HEAD = '<div><h1>Workflow</h1><p class="fd-desc">Decide what the agent does at each step of a task. Pick a step, write its instructions, and choose the skills and agents it should use.</p></div>';
  const PLACEHOLDERS = [['{id}', 'the task id, for example app-42'], ['{dir}', 'the folder that holds the task documents: triage.md, plan.md, pr-body.md'], ['{worktree}', 'the folder where the agent edits the code for this task'], ['{types}', 'the task types, for example bug|feature|docs|chore'], ['{headings}', 'the sections plan.md must have']];
  const PIPES = [['stages', 'Issue to pull request'], ['review', 'Pull request review']];
  let scope = 'global', pipeline = 'stages', stage = 'triage', info = null, draft = {}, previewType = '', loading = false, timer = null, showSuggestions = false, adding = false;

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const scopeName = () => (scope === 'global' ? 'all projects' : scope);
  const BLANK = { instructions: '', use: [], model: '', skipFor: [] };
  const inherited = (p = pipeline, s = stage) => info.inherited[p][s] || BLANK;
  const custom = () => draft.customStages || info.inherited.customStages;
  const removed = () => draft.removed || info.inherited.removed;
  const effective = (p = pipeline, s = stage) => ({ ...inherited(p, s), ...draft[p]?.[s] });
  const types = () => draft.types || info.inherited.types;
  const lines = (text) => [...new Set(text.split('\n').map(line => line.trim()).filter(Boolean))];
  const shapeOf = (p = pipeline, s = stage) => info.shape[p].find(item => item.stage === s);
  const label = (p, s) => `${p === 'review' ? 'review · ' : ''}${shapeOf(p, s)?.title || s}`;
  const assets = () => (info.assets ? [...info.assets.agents, ...info.assets.skills] : []);
  // Looks up a skill or agent by reference: the repository's first, then the user's own.
  const describe = (ref, kind) => assets().find(a => a.ref === ref) || info.user[kind === 'agent' ? 'agents' : 'skills'].find(a => a.name === ref);

  // Lists what differs from the saved workflow, as readable names.
  function changes() {
    if (!info) return [];
    const out = [];
    for (const [p] of PIPES) for (const s of new Set([...info.shape[p].map(item => item.stage), ...Object.keys(draft[p] || {}), ...Object.keys(info.override[p] || {})])) if (!same(draft[p]?.[s], info.override[p]?.[s])) out.push(label(p, s));
    if (!same(draft.customStages, info.override.customStages) || !same(draft.removed, info.override.removed)) out.push('the list of steps');
    if (!same(draft.readFirst, info.override.readFirst)) out.push('files to read first');
    if (!same(draft.types, info.override.types)) out.push('task types');
    return out;
  }

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

  function useRow(entry) {
    const known = describe(entry.ref, entry.kind);
    const name = known?.name || entry.ref;
    return `<li class="fd-use" data-ref="${escape(entry.ref)}" data-kind="${escape(entry.kind)}"><div class="fd-use-head"><span class="fd-chip">${escape(name)}</span><span class="fd-badge">${escape(entry.kind)}</span>${entry.ref.includes('/') ? `<code title="The agent reads this file and follows it">${escape(entry.ref)}</code>` : ''}<button type="button" class="fd-btn fd-ghost" data-drop-use aria-label="Remove ${escape(name)}">Remove</button></div>${known?.description ? `<p class="fd-caption">${escape(known.description)}</p>` : ''}<div class="fd-use-types"><span class="fd-caption">Only for</span>${typeChips('use', entry.types || [])}<span class="fd-caption">none selected = every type</span></div></li>`;
  }

  function picker() {
    const group = (title, items) => items.length ? `<optgroup label="${escape(title)}">${items.map(([value, text]) => `<option value="${escape(value)}">${escape(text)}</option>`).join('')}</optgroup>` : '';
    const a = info.assets;
    return `<div class="fd-pick"><select id="wf-pick" aria-label="Add a skill or agent"><option value="">Add a skill or agent…</option>${a ? group('Agents in this repository', a.agents.map(i => [`agent|${i.ref}`, i.name])) + group('Skills in this repository', a.skills.map(i => [`skill|${i.ref}`, i.name])) : ''}${group('Your agents', info.user.agents.map(a => [`agent|${a.name}`, a.name]))}${group('Your skills', info.user.skills.map(a => [`skill|${a.name}`, a.name]))}<option value="other">Other: type a name or a path</option></select><span id="wf-other" hidden><input id="wf-other-ref" aria-label="Skill or agent name, or a path in the project" placeholder="code-review or .github/agents/implementer.md"><select id="wf-other-kind" aria-label="Kind"><option value="skill">Skill</option><option value="agent">Agent</option></select><button type="button" class="fd-btn" id="wf-other-add">Add</button></span></div>`;
  }

  function strip() {
    const extra = pipeline === 'stages' ? `${info.shape.removed.map(r => `<li><div class="fd-node fd-node-removed"><span class="fd-node-top"><span class="fd-node-actor">removed</span></span><span class="fd-node-name">${escape(r.title)}</span><button type="button" class="fd-link" data-restore="${escape(r.stage)}">Put it back</button></div></li>`).join('')}<li><button type="button" class="fd-node fd-node-add" id="wf-add-step"><span class="fd-node-name">+ Add a step</span><span class="fd-node-meta">between triage and the human review</span></button></li>` : '';
    return `<ol class="fd-pipe">${info.shape[pipeline].map(({ stage: s, actor, title }, index) => {
      const value = effective(pipeline, s);
      const meta = [value.use.length ? `${value.use.length} skill${value.use.length === 1 ? '' : 's'}/agent${value.use.length === 1 ? '' : 's'}` : '', value.skipFor?.length ? `${s === 'verify' ? 'no verifier for' : 'skipped for'} ${value.skipFor.join(', ')}` : ''].filter(Boolean);
      return `<li><button type="button" class="fd-node" data-node="${escape(s)}" aria-pressed="${s === stage}"><span class="fd-node-top"><span class="fd-node-num">${index + 1}</span><span class="fd-node-actor fd-actor-${actor.toLowerCase()}">${actor}</span>${draft[pipeline]?.[s] ? `<span class="fd-node-dot" title="Customized for ${escape(scopeName())}"></span>` : ''}</span><span class="fd-node-name">${escape(title)}</span>${meta.length ? `<span class="fd-node-meta">${escape(meta.join(' · '))}</span>` : ''}</button></li>`;
    }).join('')}${extra}</ol>`;
  }

  function newStep() {
    const option = (value, text) => `<option value="${escape(value)}">${escape(text)}</option>`;
    return `<form id="wf-new-step" class="fd-panel fd-newstep"><h3>Add a step</h3><div class="fd-newstep-grid"><label>Name<input name="title" required maxlength="40" placeholder="Design review"></label><label>Place it after<select name="after">${info.shape.stages.filter(item => info.shape.anchors.includes(item.stage) || item.custom).map(item => option(item.stage, item.title)).join('')}</select></label></div><label>What happens in this step<input name="about" maxlength="200" placeholder="A designer agent checks the change against the design system."></label><p class="fd-caption">A step can go anywhere between triage and the human review. Your approval, the push and the pull request stay where they are. You write its instructions and its check next.</p><div class="fd-actions"><button type="submit" class="fd-btn fd-primary">Add step</button><button type="button" class="fd-btn fd-ghost" id="wf-cancel-step">Cancel</button></div></form>`;
  }

  // A heading with a "customized" tag and reset for the fields it covers.
  function section(number, title, hint, fields, body) {
    return `<section class="fd-sec"><header><span class="fd-sec-num">${number}</span><div><h3>${title}</h3>${hint ? `<p class="fd-caption">${hint}</p>` : ''}</div><span class="fd-custom" data-custom="${fields.join(',')}" hidden><span class="fd-badge fd-badge-warn">customized</span><button type="button" class="fd-link" data-reset="${fields.join(',')}">Use the ${scope === 'global' ? 'default' : 'value from all projects'}</button></span></header>${body}</section>`;
  }

  function editor() {
    const shape = shapeOf(), value = effective();
    const has = field => shape.fields.includes(field) && !shape.custom;
    const checkFields = shape.fields.filter(f => ['skipFor', 'headings', 'requireRegression', 'rerunGates'].includes(f));
    const question = (field, text, hint) => `<div class="fd-q"><p class="fd-q-title">${text}</p>${typeChips(field, value[field] || [])}<p class="fd-caption">${hint}</p></div>`;
    const step = shape.custom ? custom().find(item => item.id === stage) : null;
    const kind = step?.check.kind || 'none';
    const pick = (value, text, current) => `<option value="${escape(value)}" ${value === current ? 'selected' : ''}>${escape(text)}</option>`;
    const own = step ? `<label>What must be true before the task moves on?<select name="checkKind">${pick('none', 'Nothing. The agent moves on when the instructions are done', kind)}${pick('document', 'A document exists in the task folder', kind)}${pick('command', 'A command passes', kind)}</select></label><div data-check="document" ${kind === 'document' ? '' : 'hidden'}><label>Document name<input name="checkFile" value="${escape(step.check.file || '')}" placeholder="design.md"></label><label>Sections it must have, one per line<textarea name="checkHeadings" rows="3">${escape((step.check.headings || []).join('\n'))}</textarea></label></div><div data-check="command" ${kind === 'command' ? '' : 'hidden'}><label>Command<input name="checkCmd" value="${escape(step.check.cmd || '')}" placeholder="npm run test:a11y"></label><p class="fd-caption">The agent runs it with <code>factory run &lt;id&gt; ${escape(stage)}</code>. It has to pass on the committed tree.</p></div>` : '';
    const models = info.models.models, knownModel = !value.model || models.some(m => m.id === value.model);
    const model = `<label>Model<select name="modelPick">${pick('', 'Same as the running session', value.model)}${models.map(m => pick(m.id, `${m.label} · ${m.note}`, value.model)).join('')}${pick('__other', 'Other: type a model id', knownModel ? '' : '__other')}</select></label><label id="wf-model-other" ${knownModel ? 'hidden' : ''}>Model id<input name="model" value="${escape(knownModel ? '' : value.model)}" placeholder="claude-sonnet-5-5"></label><p class="fd-caption">Models of ${escape(info.models.label)}. The name always points at the newest model of that family.</p>`;
    const settings = step ? `<details class="fd-more"><summary>Step name and position</summary><label>Name<input name="stepTitle" maxlength="40" value="${escape(step.title)}"></label><label>What happens in this step<input name="stepAbout" maxlength="200" value="${escape(step.about)}"></label><label>Place it after<select name="stepAfter">${info.shape.stages.filter(item => item.stage !== stage && (info.shape.anchors.includes(item.stage) || (item.custom && custom().findIndex(c => c.id === item.stage) < custom().findIndex(c => c.id === stage)))).map(item => pick(item.stage, item.title, step.after)).join('')}</select></label></details>` : '';
    const checks = `<p class="fd-done"><span>Done when</span> <span id="wf-rule">${escape(shape.rule)}</span></p>` + (shape.configurable ? '' : '<p class="fd-caption">This check is fixed and cannot be changed here.</p>') + own
      + (step ? question('skipFor', 'Which task types skip this step?', 'A selected type goes straight to the next step.') : '')
      + (has('skipFor') && stage !== 'verify' ? question('skipFor', 'Which task types skip this step?', 'A selected type goes straight to the next step.') : '')
      + (has('headings') ? `<label>Sections plan.md must have, one per line<textarea name="headings" rows="4">${escape((value.headings || []).join('\n'))}</textarea></label>` : '')
      + (has('requireRegression') ? question('requireRegression', 'Which task types must prove the fix with a test?', 'The test has to fail on the base branch and pass on the change.') : '')
      + (has('skipFor') && stage === 'verify' ? question('skipFor', 'Which task types need no second agent?', 'The PR description and commit checks still apply to every type.') : '')
      + (has('rerunGates') ? `<label class="fd-check"><input type="checkbox" name="rerunGates" ${value.rerunGates ? 'checked' : ''}><span>The verifier runs every check again itself</span></label>` : '');
    return `<form id="wf-form" class="fd-panel fd-editor"><header class="fd-editor-head"><div><h2>${escape(shape.title)}</h2><p class="fd-caption">${escape(shape.about || 'A step you added.')}</p></div><span class="fd-actions"><span class="fd-node-actor fd-actor-${shape.actor.toLowerCase()}">${shape.actor} acts</span>${shape.removable && pipeline === 'stages' ? '<button type="button" class="fd-btn fd-ghost" id="wf-remove-step">Remove this step</button>' : ''}</span></header>`
      + section(1, 'Instructions', 'What the agent is told when a task reaches this step.', ['instructions'], `<textarea name="instructions" rows="7" aria-label="Instructions for the agent">${escape(value.instructions)}</textarea><p class="fd-caption fd-ph-title">Click to insert a value the factory fills in for each task:</p><ul class="fd-ph">${PLACEHOLDERS.map(([token, title]) => `<li><button type="button" class="fd-chip-btn" data-insert="${token}">${token}</button><span>${escape(title)}</span></li>`).join('')}</ul>`)
      + section(2, 'Skills and agents', 'Optional. The agent is told to use these at this step.', ['use'], `<ul id="wf-use" class="fd-use-list">${value.use.map(useRow).join('')}</ul><p class="fd-caption" id="wf-use-empty" ${value.use.length ? 'hidden' : ''}>None. The agent works from the instructions alone.</p>${picker()}`)
      + section(3, 'Check before moving on', '', checkFields, checks)
      + section(4, 'Model', 'Optional. Which model should do this step.', ['model'], model)
      + `${settings}<p id="wf-error" role="alert"></p></form>`;
  }

  function basics() {
    const showTypes = scope === 'global';
    return `<details class="fd-panel fd-general" ${draft.readFirst || draft.types ? 'open' : ''}><summary>Settings for every step${draft.readFirst || draft.types ? ' · customized' : ''}</summary><label>Files the agent reads before every step, one per line<textarea id="wf-read-first" rows="2" placeholder="AGENTS.md">${escape((draft.readFirst || info.inherited.readFirst).join('\n'))}</textarea></label>${showTypes ? `<label>Task types, one per line<textarea id="wf-types" rows="4">${escape(types().join('\n'))}</textarea></label><p class="fd-caption">Triage gives every task one of these types. The per-type choices above use them.</p>` : ''}</details>`;
  }

  function suggestions() {
    if (scope === 'global' || !info.assets || !info.proposals.length) return '';
    const reusable = info.assets.agents.length + info.assets.skills.length;
    return `<details class="fd-callout" id="wf-suggestions" ${showSuggestions ? 'open' : ''}><summary><strong>${escape(scope)} already has ${reusable ? `${reusable} agent${reusable === 1 ? '' : 's'} and skill${reusable === 1 ? '' : 's'}` : 'instruction files'} you can reuse.</strong> ${info.proposals.length} suggestion${info.proposals.length === 1 ? '' : 's'} to review</summary><p class="fd-caption">Each suggestion is a guess from a file name, so read what it does before you accept it. Nothing changes until you accept, nothing is written into the repository, and every one can be undone.</p><ul class="fd-issues">${info.proposals.map(p => `<li class="fd-issue"><div><p class="fd-issue-title">${escape(p.title)}</p><p class="fd-issue-meta"><span>${escape(p.reason)}</span></p><dl class="fd-effect"><dt>If you accept</dt><dd>${escape(p.effect)}</dd><dt>To undo</dt><dd>${escape(p.undo)}</dd></dl>${p.note ? `<p class="fd-issue-meta fd-warning">${escape(p.note)}</p>` : ''}</div><div class="fd-issue-action">${p.action === 'use' ? `<button type="button" class="fd-btn fd-ghost" data-show-step="${escape(p.pipeline)}:${escape(p.stage)}">Show the step</button>` : ''}<button type="button" class="fd-btn" data-accept="${escape(p.id)}">Accept</button><button type="button" class="fd-btn fd-ghost" data-dismiss="${escape(p.id)}">Dismiss</button></div></li>`).join('')}</ul><div class="fd-actions fd-callout-foot"><button type="button" class="fd-btn" id="wf-accept-all">Accept all ${info.proposals.length}</button></div></details>`;
  }

  function inventory() {
    if (scope === 'global' || !info.assets) return '';
    const a = info.assets;
    const group = (title, items) => items.length ? `<h4>${title} <span class="fd-muted">${items.length}</span></h4><ul class="fd-asset-list">${items.map(i => `<li><span class="fd-chip">${escape(i.name)}</span>${i.differs ? '<span class="fd-badge fd-badge-warn">copies differ</span>' : ''}<code>${escape(i.path)}</code>${i.description ? `<span class="fd-asset-desc">${escape(i.description)}</span>` : ''}</li>`).join('')}</ul>` : '';
    return `<details class="fd-panel fd-general"><summary>Everything found in the ${escape(scope)} repository</summary>${group('Agents', a.agents)}${group('Skills for contributors', a.skills)}${group('Skills for library users, not suggested', a.products)}<h4>Instruction files</h4><p class="fd-caption">${escape(a.instructions.join(', ') || 'none')}</p><h4>PR template</h4><p class="fd-caption">${escape(a.prTemplate || 'none')}</p></details>`;
  }

  function render() {
    if (!served) { el.innerHTML = `<header class="fd-page-head">${HEAD}</header><p class="fd-blank">This view needs the local server. Run <code>factory board</code>.</p>`; return; }
    if (!info) { el.innerHTML = `<header class="fd-page-head">${HEAD}</header><p class="fd-blank">${loading ? 'Loading the workflow…' : 'The workflow could not be loaded.'}</p>`; return; }
    if (!shapeOf()) stage = info.shape[pipeline][1].stage;
    if (pipeline !== 'stages') adding = false;
    const option = (value, text) => `<option value="${escape(value)}" ${value === scope ? 'selected' : ''}>${escape(text)}</option>`;
    el.innerHTML = `<header class="fd-page-head">${HEAD}<label class="fd-scope">Editing the workflow for<select id="wf-scope">${option('global', 'All projects')}${projects().map(p => option(p.key, p.key)).join('')}</select></label></header>`
      + `<p class="fd-scope-note">${scope === 'global' ? 'This is the shared workflow. Every project follows it unless it has its own value.' : `You are changing <strong>${escape(scope)}</strong> only. Anything you leave alone follows the shared workflow of all projects.`}</p>`
      + suggestions()
      + `<div class="fd-pipe-head"><div class="fd-switch" role="group" aria-label="Kind of task">${PIPES.map(([key, text]) => `<button type="button" data-pipe="${key}" aria-pressed="${key === pipeline}">${text}</button>`).join('')}</div><p class="fd-legend"><span class="fd-node-actor fd-actor-agent">Agent</span><span class="fd-node-actor fd-actor-verifier">Verifier</span><span class="fd-node-actor fd-actor-you">You</span><span class="fd-node-actor fd-actor-factory">Factory</span><span class="fd-caption">who acts at each step</span></p></div><div id="wf-strip">${strip()}</div>${adding ? newStep() : ''}`
      + `<div class="fd-wf-grid">${editor()}<aside class="fd-panel fd-preview"><div class="fd-editor-head"><h3>What the agent sees</h3><label class="fd-inline">for a<select id="wf-preview-type"><option value="">task of any type</option>${types().map(t => `<option ${t === previewType ? 'selected' : ''}>${escape(t)}</option>`).join('')}</select></label></div><pre id="wf-preview" aria-live="polite">Loading…</pre><p class="fd-caption">Updates as you type. This is what <code>factory next</code> prints for a task at this step.</p></aside></div>`
      + basics() + inventory()
      + '<div class="fd-savebar" id="wf-savebar" hidden><span id="wf-changed"></span><span class="fd-actions"><button type="button" class="fd-btn fd-ghost" id="wf-discard">Discard</button><button type="button" class="fd-btn fd-primary" id="wf-save">Save changes</button></span></div>';
    mark();
    preview();
  }

  async function preview() {
    const target = `${scope}|${pipeline}|${stage}|${previewType}|${JSON.stringify(draft)}`;
    try {
      const result = await post('/api/workflow/preview', { scope, workflow: draft, pipeline, stage, type: previewType });
      if (target !== `${scope}|${pipeline}|${stage}|${previewType}|${JSON.stringify(draft)}` || !$('wf-preview')) return;
      $('wf-preview').textContent = result.text; $('wf-preview').classList.remove('fd-failed');
      info.shape = result.shape;
      if ($('wf-rule') && shapeOf()) $('wf-rule').textContent = shapeOf().rule;
    } catch (error) { if ($('wf-preview')) { $('wf-preview').textContent = `This cannot be saved yet:\n\n${error.message}`; $('wf-preview').classList.add('fd-failed'); } }
  }

  // Refreshes what depends on the draft without touching the fields being edited.
  function mark() {
    const changed = changes();
    if ($('wf-savebar')) { $('wf-savebar').hidden = !changed.length; $('wf-changed').textContent = `Unsaved changes for ${scopeName()}: ${changed.join(', ')}`; }
    if ($('wf-strip') && !$('wf-strip').contains(document.activeElement)) $('wf-strip').innerHTML = strip();
    for (const tag of el.querySelectorAll('[data-custom]')) tag.hidden = !tag.dataset.custom.split(',').some(field => field && draft[pipeline]?.[stage]?.[field] !== undefined);
    if ($('wf-use-empty')) $('wf-use-empty').hidden = Boolean($('wf-use').children.length);
  }

  const pressed = container => [...container.querySelectorAll('[aria-pressed=true]')].map(button => button.dataset.type);

  // Moves the form into the draft; a value equal to the inherited one is not stored.
  function collect() {
    const form = $('wf-form');
    if (!form || !info) return;
    const shape = shapeOf(), base = { ...inherited() }, current = {};
    current.instructions = form.elements.instructions.value.trim();
    current.model = form.elements.modelPick.value === '__other' ? form.elements.model.value.trim() : form.elements.modelPick.value;
    if (shape.custom) {
      const kind = form.elements.checkKind.value;
      const check = kind === 'document' ? { kind, file: form.elements.checkFile.value.trim(), headings: lines(form.elements.checkHeadings.value) } : kind === 'command' ? { kind, cmd: form.elements.checkCmd.value.trim() } : { kind: 'none' };
      const list = custom().map(item => (item.id === stage ? { ...item, title: form.elements.stepTitle.value.trim() || item.id, about: form.elements.stepAbout.value.trim(), after: form.elements.stepAfter.value || item.after, check } : item));
      if (same(list, info.inherited.customStages)) delete draft.customStages; else draft.customStages = list;
    }
    current.use = [...form.querySelectorAll('.fd-use')].map(row => {
      const only = pressed(row.querySelector('[data-types]'));
      return { ref: row.dataset.ref, kind: row.dataset.kind, ...(only.length ? { types: only } : {}) };
    });
    for (const field of ['skipFor', 'requireRegression']) if (shape.fields.includes(field)) current[field] = pressed(form.querySelector(`[data-types=${field}]`));
    if (shape.custom) { if (!current.skipFor.length) delete current.skipFor; if (!base.skipFor?.length) delete base.skipFor; }
    if (shape.fields.includes('headings')) current.headings = lines(form.elements.headings.value);
    if (shape.fields.includes('rerunGates')) current.rerunGates = form.elements.rerunGates.checked;
    const changed = Object.fromEntries(Object.entries(current).filter(([field, value]) => !same(value, base[field])));
    draft[pipeline] = { ...draft[pipeline] };
    if (Object.keys(changed).length) draft[pipeline][stage] = changed; else delete draft[pipeline][stage];
    if (!Object.keys(draft[pipeline]).length) delete draft[pipeline];
    const readFirst = lines($('wf-read-first').value);
    if (same(readFirst, info.inherited.readFirst)) delete draft.readFirst; else draft.readFirst = readFirst;
    if ($('wf-types')) { const taskTypes = lines($('wf-types').value); if (same(taskTypes, info.inherited.types)) delete draft.types; else draft.types = taskTypes; }
  }

  function edited() {
    collect(); mark();
    clearTimeout(timer); timer = setTimeout(preview, 350);
  }

  function addUse(ref, kind) {
    if (!ref) return;
    if ([...$('wf-use').children].some(row => row.dataset.ref === ref)) { notice(`${ref} is already used at this step.`); return; }
    $('wf-use').insertAdjacentHTML('beforeend', useRow({ ref, kind, types: [] }));
    edited();
  }

  // Applies a change to the list of steps and redraws with the stage order the server derives from it.
  async function reshape() {
    try {
      const result = await post('/api/workflow/preview', { scope, workflow: draft, pipeline, stage: 'triage', type: '' });
      info.shape = result.shape;
    } catch (error) { notice(error.message); }
    render();
  }

  async function save() {
    collect();
    const known = [...info.shape.stages, ...info.shape.removed].map(item => item.stage);
    for (const key of Object.keys(draft.stages || {})) if (!known.includes(key)) delete draft.stages[key];
    try { await post('/api/workflow', { scope, workflow: draft }); notice(`Workflow saved for ${scopeName()}.`); await load(); }
    catch (error) { $('wf-error').textContent = error.message; $('wf-error').scrollIntoView({ block: 'center' }); }
  }

  async function suggest(pathname, ids, done) {
    if (changes().length) { notice('Save or discard your unsaved changes first, then accept suggestions.'); return; }
    try { await post(pathname, { project: scope, ids }); notice(done); await load(); }
    catch (error) { notice(error.message); }
  }

  el.addEventListener('click', e => {
    const node = e.target.closest('[data-node]'), type = e.target.closest('[data-type]'), pipe = e.target.closest('[data-pipe]'), reset = e.target.closest('[data-reset]'), insert = e.target.closest('[data-insert]');
    if (type) { type.setAttribute('aria-pressed', type.getAttribute('aria-pressed') !== 'true'); edited(); return; }
    if (node) { collect(); stage = node.dataset.node; render(); el.querySelector(`[data-node="${stage}"]`)?.focus({ preventScroll: true }); return; }
    if (pipe) { collect(); pipeline = pipe.dataset.pipe; stage = info.shape[pipeline][1].stage; render(); return; }
    if (reset) { for (const field of reset.dataset.reset.split(',')) delete draft[pipeline]?.[stage]?.[field]; if (draft[pipeline]?.[stage] && !Object.keys(draft[pipeline][stage]).length) delete draft[pipeline][stage]; render(); return; }
    if (insert) {
      const area = $('wf-form').elements.instructions, at = area.selectionStart ?? area.value.length;
      area.setRangeText(insert.dataset.insert, at, area.selectionEnd ?? at, 'end'); area.focus(); edited(); return;
    }
    if (e.target.closest('#wf-add-step')) { collect(); adding = true; render(); $('wf-new-step').elements.title.focus(); return; }
    if (e.target.id === 'wf-cancel-step') { adding = false; render(); return; }
    if (e.target.dataset.restore) { collect(); draft.removed = removed().filter(s => s !== e.target.dataset.restore); if (same(draft.removed, info.inherited.removed)) delete draft.removed; reshape(); return; }
    if (e.target.id === 'wf-remove-step') {
      const shape = shapeOf(), index = info.shape.stages.findIndex(item => item.stage === stage);
      if (shape.custom) {
        const gone = custom().find(item => item.id === stage);
        draft.customStages = custom().filter(item => item.id !== stage).map(item => (item.after === stage ? { ...item, after: gone.after } : item));
        if (draft.stages) delete draft.stages[stage];
      } else draft.removed = [...new Set([...removed(), stage])];
      if (same(draft.customStages, info.inherited.customStages)) delete draft.customStages;
      stage = info.shape.stages[Math.max(index - 1, 1)].stage;
      $('wf-form').remove(); reshape(); return;
    }
    if (e.target.closest('[data-drop-use]')) { e.target.closest('.fd-use').remove(); edited(); }
    if (e.target.id === 'wf-other-add') { addUse($('wf-other-ref').value.trim(), $('wf-other-kind').value); $('wf-other-ref').value = ''; }
    if (e.target.id === 'wf-save') save();
    if (e.target.id === 'wf-discard') { draft = structuredClone(info.override); render(); }
    if (e.target.id === 'wf-accept-all' && !confirm(`Accept all ${info.proposals.length} suggestions for ${scope}?\n\n${info.proposals.map(p => `• ${p.title}`).join('\n')}`)) return;
    if (e.target.id === 'wf-accept-all') suggest('/api/workflow/accept', info.proposals.map(p => p.id), `${scope}: ${info.proposals.length} suggestion(s) applied.`);
    if (e.target.dataset.showStep) { collect(); [pipeline, stage] = e.target.dataset.showStep.split(':'); render(); $('wf-form').scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    if (e.target.dataset.accept) {
      const accepted = info.proposals.find(p => p.id === e.target.dataset.accept);
      // Lands on the step the suggestion changed, so its effect is visible in the editor and the preview.
      if (accepted?.action === 'use') { pipeline = accepted.pipeline; stage = accepted.stage; }
      suggest('/api/workflow/accept', [accepted.id], `Accepted: ${accepted.title}. ${accepted.undo}`);
    }
    if (e.target.dataset.dismiss) suggest('/api/workflow/dismiss', [e.target.dataset.dismiss], `${scope}: suggestion dismissed.`);
  });
  el.addEventListener('input', e => { if (e.target.closest('#wf-form, .fd-general') && !e.target.closest('.fd-pick')) edited(); });
  el.addEventListener('change', e => {
    if (e.target.id === 'wf-scope') {
      if (changes().length && !confirm('Discard the unsaved workflow changes?')) { e.target.value = scope; return; }
      scope = e.target.value; info = null; load();
    }
    if (e.target.id === 'wf-preview-type') { previewType = e.target.value; preview(); }
    if (e.target.name === 'modelPick') { $('wf-model-other').hidden = e.target.value !== '__other'; if (e.target.value === '__other') $('wf-form').elements.model.focus(); }
    if (e.target.name === 'checkKind') for (const block of el.querySelectorAll('[data-check]')) block.hidden = block.dataset.check !== e.target.value;
    if (e.target.name === 'stepAfter') { collect(); reshape(); }
    if (e.target.id === 'wf-pick') {
      const value = e.target.value;
      $('wf-other').hidden = value !== 'other';
      if (value === 'other') { $('wf-other-ref').focus(); return; }
      if (value) { const [kind, ...ref] = value.split('|'); addUse(ref.join('|'), kind); }
      e.target.value = '';
    }
  });
  el.addEventListener('toggle', e => { if (e.target.id === 'wf-suggestions') showSuggestions = e.target.open; }, true);
  el.addEventListener('submit', e => {
    e.preventDefault();
    if (e.target.id !== 'wf-new-step') return save();
    const form = e.target, title = form.elements.title.value.trim();
    let id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
    if (id.length < 2) id = `step-${id || 'x'}`;
    const taken = [...info.shape.stages, ...info.shape.review, ...info.shape.removed].map(item => item.stage);
    for (let n = 2; taken.includes(id); n++) id = `${id.replace(/-\d+$/, '').slice(0, 21)}-${n}`;
    draft.customStages = [...custom(), { id, title, about: form.elements.about.value.trim(), after: form.elements.after.value, check: { kind: 'none' } }];
    adding = false; stage = id; reshape();
  });
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'wf-other-ref') { e.preventDefault(); $('wf-other-add').click(); } });

  return {
    open() { if (!info && !loading) load(); else if (!changes().length) render(); },
    // True while edits would be lost by a redraw.
    busy: () => changes().length > 0,
  };
}
