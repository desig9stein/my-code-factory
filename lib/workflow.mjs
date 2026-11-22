// Holds the configurable part of the workflow: stage briefs, skills and agents, and per-type checks.
import { withSettings } from './lock.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { codeRoot, factoryRoot, issueDir, within } from './paths.mjs';
import { getRepo, loadRegistry } from './registry.mjs';
import { REVIEW_STAGES, STAGES } from './pipeline.mjs';
import { writeJson } from './store.mjs';

export const workflowPath = () => path.join(factoryRoot(), 'workflow.json');

const PIPELINES = { stages: STAGES, review: REVIEW_STAGES };
const COMMON_FIELDS = ['instructions', 'use', 'model'];
// Fields that change an exit rule, by issue stage. Every other exit rule is fixed.
const RULE_FIELDS = { reproduce: ['skipFor'], plan: ['skipFor', 'headings'], gates: ['requireRegression'], verify: ['skipFor', 'rerunGates'] };
const TOP_FIELDS = ['types', 'readFirst', 'stages', 'review', 'customStages', 'removed', 'maxAttempts', 'lessons'];
const MAX_LESSONS = 20;
// Built-in steps a workflow can drop. The others carry a rule the factory depends on.
const REMOVABLE = ['reproduce', 'plan'];
// A custom step sits after one of these, so it always lies between triage and the human review.
const ANCHORS = ['triage', 'reproduce', 'plan', 'implement', 'gates', 'verify'];
const RESERVED_IDS = [...STAGES, ...REVIEW_STAGES, 'install', 'regress', 'verdict', 'blocked', 'archived'];
const STEP_ID = /^[a-z][a-z0-9-]{1,23}$/;
const CUSTOM_FIELDS = ['instructions', 'use', 'model', 'skipFor'];
const MAX_CUSTOM = 6;
// Shown instead of the stage key where a person reads it.
const TITLES = {
  stages: { gates: 'checks', ready: 'your review', approved: 'open the PR', 'pr-opened': 'PR opened' },
  review: { ready: 'your review', approved: 'post the review' },
};
const TYPE_NAME = /^[a-z][a-z0-9-]{0,19}$/;
const REF_NAME = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]*$/;
const MODEL = /^[a-zA-Z0-9._-]{0,60}$/;
const MAX_TEXT = 4000;

const DEFAULT_TYPES = ['bug', 'feature', 'docs', 'chore'];
// Default models are family aliases. The strongest model goes where a mistake costs the most:
// planning and the last automated check. Mechanical steps use faster models.
const DEFAULTS = {
  types: DEFAULT_TYPES,
  readFirst: [],
  customStages: [],
  removed: [],
  // Failed check runs at one step, or failed verdicts on one task, before the task waits for a person.
  maxAttempts: 5,
  lessons: [],
  stages: {
    intake: { instructions: 'The issue snapshot is in {dir}/issue.md and the worktree is {worktree}. Read the issue, then advance.' },
    triage: { model: 'opus', instructions: 'Read the issue and the code it touches. Write {dir}/triage.md with three lines: "Type: {types}", "Scope: what changes and what stays out", "Verdict: clear|unclear". Add "Tier: trivial" only for a clear change of one or two files; it skips reproduce and plan, and the gates, the verifier and the human review still apply. When the issue is unclear, or a suggestion in it looks wrong, set "Verdict: unclear" and draft the follow-up questions in {dir}/questions.md. Nothing is posted; the user reviews the draft.' },
    reproduce: { model: 'sonnet', instructions: 'Show the bug before changing any code. Build a pass/fail signal that fails because of this bug, trying in this order: a failing test at the public boundary that reaches the bug; a script or request against a running dev server; a command-line run with a fixed input, compared with known-good output; a headless browser script; a replay of a captured request or event; a minimal harness around the code path. Make it fast and specific to this bug, then record it: factory run {id} reproduce --expect-fail -- <command>. Only when no command can show it (a visual defect), record what you saw: factory note {id} reproduce <text>. Do not start fixing in this step.' },
    plan: { model: 'fable', headings: ['Acceptance criteria', 'Files', 'Test boundaries', 'Tests', 'Consumer impact', 'Changelog'], skipFor: [], instructions: 'Write {dir}/plan.md with these sections: {headings}. Keep it short: the acceptance criteria as a list of observable results the verifier can check; the files to change; the test boundaries (the public interfaces the tests go through, each with what it catches); the tests that prove the change; who is affected; and the changelog line.' },
    implement: { model: 'opus', instructions: 'Implement the plan inside {worktree}, on the task branch. Where the project has tests, work test-first at the boundaries the plan names: write one failing test, then only the code that makes it pass, one slice at a time. Run the type check and the test files you touch as you go. Follow the project instructions and its code style. Commit with Conventional Commits and a scope; the subject names the behavior. Leave the tree clean. Do not push.' },
    gates: { model: 'sonnet', requireRegression: ['bug'], instructions: 'Run every gate on the committed tree: factory run {id} <gate>. Fix what fails, commit, and run again. For a task that needs regression proof, show that the new test fails on the base and passes on the fix: factory regress {id} --tests <paths> -- <test command>.' },
    verify: { model: 'fable', skipFor: [], rerunGates: true, use: [{ ref: 'factory-verifier', kind: 'agent' }], instructions: 'Write the PR description to {dir}/pr-body.md: what changed and why, the evidence (output or a test run before and after), and the merge risk (how easily it reverts, what it could break). Run factory check {id}. Then hand the task to an independent verifier with a fresh context. It re-runs the gates with "--as verifier" and judges two things separately: standards (does the diff follow this repository\'s documented rules) and intent (does it do what the issue asked, and nothing else). It checks every claim in the PR description against the diff, writes its report, and records factory verdict {id} pass|fail --report <file>. Do not verify your own work.' },
    ready: { model: 'sonnet', instructions: 'Stop here. Tell the user the task is ready and summarize what changed and how it was checked. The user reads the diff, the evidence and the PR description, then approves. Never approve, push or open the board yourself.' },
    approved: { model: 'haiku', instructions: 'The user approved this commit. Push the branch and open the pull request with the text of {dir}/pr-body.md, then record it: factory pr {id} <url>.' },
    'pr-opened': { instructions: 'The pull request is open. Nothing follows; the user archives the task after it merges.' },
  },
  review: {
    intake: { instructions: 'The pull request snapshot is in {dir}/pr.md and the worktree at its head is {worktree}. Read it, then advance.' },
    checks: { model: 'sonnet', instructions: 'Run every gate at the pull request head: factory run {id} <gate> --as reviewer. A failing gate is a finding, not a blocker for the review. Never commit or push in this worktree.' },
    draft: { model: 'opus', instructions: 'Write the review to {dir}/review.md. The first line is "Verdict: approve|request-changes|comment". Say what is right, then list findings with file:line, the evidence, and the fix. Split blocking from non-blocking.' },
    ready: { model: 'sonnet', instructions: 'Stop here. Tell the user the draft is ready. The user reads it and approves that exact text. Never approve or post yourself.' },
    approved: { model: 'haiku', instructions: 'The user approved this draft. Post the review on the pull request with the approved text, then record it: factory posted {id}.' },
    posted: { instructions: 'The review is posted. After new pushes, run factory refresh {id} and review again.' },
  },
};

// Exit rules the configuration cannot change, in plain words.
const EXIT = {
  stages: {
    intake: 'issue.md and the worktree exist.',
    triage: 'triage.md has valid "Type:", "Scope:" and "Verdict:" lines. An unclear verdict blocks the task until the user unblocks it.',
    reproduce: 'A recorded reproduction shows the bug (a command that fails, or a manual note).',
    plan: 'plan.md has every required section.',
    implement: 'The branch has at least one commit and the worktree is clean.',
    gates: 'Every gate passed at HEAD on a clean tree, plus the regression proof for the types that need it.',
    verify: 'pr-body.md and the commits pass their checks, and the verifier recorded a passing verdict at HEAD.',
    ready: 'The user approves the commit and the PR description shown on the board.',
    approved: 'The pull request URL is recorded.',
    'pr-opened': 'Final stage.',
  },
  review: {
    intake: 'pr.md and the worktree exist.',
    checks: 'Every gate has a run at the pull request head on a clean tree.',
    draft: 'review.md starts with a verdict line and reads as a review.',
    ready: 'The user approves the draft shown on the board.',
    approved: 'The posted review is recorded.',
    posted: 'Final stage.',
  },
};

// Who acts in a stage and what happens there, for the Workflow page.
const ABOUT = {
  stages: {
    intake: ['Factory', 'The issue is fetched and an isolated worktree is created.'],
    triage: ['Agent', 'Classifies the issue and decides whether it is clear enough to start.'],
    reproduce: ['Agent', 'Shows the bug before any code changes.'],
    plan: ['Agent', 'Writes a short plan: files, tests, who is affected.'],
    implement: ['Agent', 'Writes the change in the worktree and commits it.'],
    gates: ['Agent', "Runs the project's checks on the commit."],
    verify: ['Verifier', 'A second agent checks the work and the PR description.'],
    ready: ['You', 'You read the diff and the evidence, then approve.'],
    approved: ['Agent', 'Pushes the branch and opens the pull request.'],
    'pr-opened': ['Factory', 'Waits for the merge. You archive the task.'],
  },
  review: {
    intake: ['Factory', 'The pull request is fetched and checked out at its head.'],
    checks: ['Agent', "Runs the project's checks on the pull request."],
    draft: ['Agent', 'Writes the review with a verdict and findings.'],
    ready: ['You', 'You read the draft review, then approve it.'],
    approved: ['Agent', 'Posts the approved review.'],
    posted: ['Factory', 'Waits for new pushes to review again.'],
  },
};

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function typeList(value, types, what) {
  if (!Array.isArray(value)) throw new Error(`${what} must be a list of task types. Valid types: ${types.join(', ')}.`);
  const bad = value.find((type) => !types.includes(type));
  if (bad !== undefined) throw new Error(`${what} names "${bad}", which is not a task type. Valid types: ${types.join(', ')}.`);
  return [...new Set(value)];
}

function checkUse(value, types, where) {
  if (!Array.isArray(value)) throw new Error(`${where}.use must be a list of { ref, kind, types }.`);
  if (value.length > 8) throw new Error(`${where}.use has ${value.length} entries; the limit is 8.`);
  return value.map((entry, index) => {
    const at = `${where}.use[${index + 1}]`;
    if (!isObject(entry)) throw new Error(`${at} must be { ref, kind, types }.`);
    const extra = Object.keys(entry).find((k) => !['ref', 'kind', 'types'].includes(k));
    if (extra) throw new Error(`${at} has an unknown field "${extra}". Valid fields: ref, kind, types.`);
    const ref = String(entry.ref ?? '').trim();
    const isPath = ref.includes('/');
    if (!ref || ref.length > 200) throw new Error(`${at}.ref must be a skill or agent name, or a path inside the project, of at most 200 characters.`);
    if (isPath && (path.isAbsolute(ref) || ref.split('/').includes('..') || !ref.endsWith('.md'))) throw new Error(`${at}.ref "${ref}" must be a Markdown file path relative to the project, for example ".github/agents/implementer.md".`);
    if (!isPath && !REF_NAME.test(ref)) throw new Error(`${at}.ref "${ref}" is not a skill or agent name. Use letters, digits, ":", "_", "." and "-".`);
    if (!['skill', 'agent'].includes(entry.kind)) throw new Error(`${at}.kind must be "skill" or "agent", got ${JSON.stringify(entry.kind)}.`);
    const out = { ref, kind: entry.kind };
    if (entry.types !== undefined && entry.types.length) out.types = typeList(entry.types, types, `${at}.types`);
    return out;
  });
}

function checkCustomStages(value) {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM) throw new Error(`customStages must be a list of at most ${MAX_CUSTOM} steps.`);
  const seen = [];
  return value.map((step, index) => {
    const at = `customStages[${index + 1}]`;
    if (!isObject(step)) throw new Error(`${at} must be { id, title, about, after, check }.`);
    const extra = Object.keys(step).find((k) => !['id', 'title', 'about', 'after', 'check'].includes(k));
    if (extra) throw new Error(`${at} has an unknown field "${extra}". Valid fields: id, title, about, after, check.`);
    const id = String(step.id ?? '');
    if (!STEP_ID.test(id)) throw new Error(`Step id "${id}" is not valid. Use 2 to 24 lowercase letters, digits and hyphens, starting with a letter, for example "design-review".`);
    if (RESERVED_IDS.includes(id)) throw new Error(`Step id "${id}" is already used by the factory. Pick another name.`);
    if (seen.includes(id)) throw new Error(`Step id "${id}" is used twice. Every step needs its own name.`);
    const after = String(step.after ?? '');
    if (!ANCHORS.includes(after) && !seen.includes(after)) throw new Error(`Step "${id}" cannot go after "${after}". A step goes after one of: ${[...ANCHORS, ...seen].join(', ')}. Steps after the human review are fixed.`);
    const title = String(step.title ?? id).trim() || id;
    const about = String(step.about ?? '').trim();
    if (/[\r\n]/.test(title) || title.length > 40) throw new Error(`The name of step "${id}" must be one line of at most 40 characters.`);
    if (about.length > 200) throw new Error(`The description of step "${id}" is ${about.length} characters; the limit is 200.`);
    const input = isObject(step.check) ? step.check : { kind: 'none' };
    let check;
    if (input.kind === 'none') check = { kind: 'none' };
    else if (input.kind === 'document') {
      const file = String(input.file ?? '').trim();
      if (!/^[a-z0-9][a-z0-9._-]{0,40}\.md$/i.test(file) || ['issue.md', 'pr.md', 'verify.md'].includes(file.toLowerCase())) throw new Error(`Step "${id}" needs a document name such as "design.md"; got "${file}". issue.md, pr.md and verify.md are written by the factory.`);
      const headings = input.headings ?? [];
      if (!Array.isArray(headings) || headings.length > 10 || headings.some((h) => typeof h !== 'string' || !h.trim() || /[\r\n#]/.test(h) || h.length > 60)) throw new Error(`The sections of step "${id}" must be at most 10 names, each one line of at most 60 characters without "#".`);
      check = { kind: 'document', file, headings: [...new Set(headings.map((h) => h.trim()))] };
    } else if (input.kind === 'command') {
      const cmd = String(input.cmd ?? '').trim();
      if (!cmd || /[\r\n]/.test(cmd) || cmd.length > 500) throw new Error(`Step "${id}" needs a check command: one line of at most 500 characters.`);
      check = { kind: 'command', cmd };
    } else throw new Error(`Step "${id}" has check kind ${JSON.stringify(input.kind)}. Valid kinds: none, document, command.`);
    seen.push(id);
    return { id, title, about, after, check };
  });
}

function checkStage(pipeline, stage, input, types, customIds = []) {
  const where = `${pipeline}.${stage}`;
  const custom = pipeline === 'stages' && customIds.includes(stage);
  if (!custom && !PIPELINES[pipeline].includes(stage)) throw new Error(`"${stage}" is not a stage of ${pipeline === 'review' ? 'the review' : 'the issue'} workflow. Valid stages: ${PIPELINES[pipeline].join(', ')}.`);
  if (!isObject(input)) throw new Error(`${where} must be an object.`);
  const allowed = custom ? CUSTOM_FIELDS : [...COMMON_FIELDS, ...(pipeline === 'stages' ? RULE_FIELDS[stage] || [] : [])];
  const out = {};
  for (const [field, value] of Object.entries(input)) {
    if (!allowed.includes(field)) throw new Error(`${where} has no field "${field}". Its exit rule is fixed. Fields you can set: ${allowed.join(', ')}.`);
    if (field === 'instructions') {
      if (typeof value !== 'string' || value.length > MAX_TEXT) throw new Error(`${where}.instructions must be text of at most ${MAX_TEXT} characters.`);
      out.instructions = value.trim();
    } else if (field === 'use') out.use = checkUse(value, types, where);
    else if (field === 'model') {
      if (typeof value !== 'string' || !MODEL.test(value)) throw new Error(`${where}.model must be a model name such as "opus" or "claude-sonnet-5-5", got ${JSON.stringify(value)}.`);
      out.model = value;
    } else if (field === 'skipFor' || field === 'requireRegression') out[field] = typeList(value, types, `${where}.${field}`);
    else if (field === 'headings') {
      if (!Array.isArray(value) || value.length > 10 || value.some((h) => typeof h !== 'string' || !h.trim() || /[\r\n#]/.test(h) || h.length > 60)) throw new Error(`${where}.headings must be at most 10 section names, each one line of at most 60 characters without "#".`);
      out.headings = [...new Set(value.map((h) => h.trim()))];
    } else if (field === 'rerunGates') {
      if (typeof value !== 'boolean') throw new Error(`${where}.rerunGates must be true or false.`);
      out.rerunGates = value;
    }
  }
  return out;
}

/** Returns a checked override; `types` are the task types it may name when it sets none itself. */
export function checkWorkflow(input, types = DEFAULT_TYPES, customIds = []) {
  if (!isObject(input)) throw new Error('The workflow must be an object.');
  const unknown = Object.keys(input).find((field) => !TOP_FIELDS.includes(field));
  if (unknown) throw new Error(`"${unknown}" is not a workflow field. Valid fields: ${TOP_FIELDS.join(', ')}.`);
  const out = {};
  if (input.types !== undefined) {
    if (!Array.isArray(input.types) || !input.types.length || input.types.length > 8 || input.types.some((type) => typeof type !== 'string' || !TYPE_NAME.test(type))) throw new Error('types must be 1 to 8 names of lowercase letters, digits and hyphens, for example "bug" or "tech-debt".');
    out.types = [...new Set(input.types)];
  }
  const known = out.types || types;
  if (input.readFirst !== undefined) {
    if (!Array.isArray(input.readFirst) || input.readFirst.length > 5 || input.readFirst.some((file) => typeof file !== 'string' || !file.trim() || path.isAbsolute(file) || file.split('/').includes('..') || file.length > 200)) throw new Error('readFirst must be at most 5 file paths relative to the project, for example "AGENTS.md".');
    out.readFirst = [...new Set(input.readFirst.map((file) => file.trim()))];
  }
  if (input.maxAttempts !== undefined) {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 20) throw new Error(`maxAttempts must be a whole number from 1 to 20, got ${JSON.stringify(input.maxAttempts)}.`);
    out.maxAttempts = input.maxAttempts;
  }
  if (input.lessons !== undefined) {
    if (!Array.isArray(input.lessons) || input.lessons.length > MAX_LESSONS || input.lessons.some((text) => typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text) || text.length > 300)) throw new Error(`lessons must be at most ${MAX_LESSONS} entries, each one line of at most 300 characters.`);
    out.lessons = [...new Set(input.lessons.map((text) => text.trim()))];
  }
  if (input.customStages !== undefined) out.customStages = checkCustomStages(input.customStages);
  const ids = out.customStages ? out.customStages.map((step) => step.id) : customIds;
  if (input.removed !== undefined) {
    if (!Array.isArray(input.removed) || input.removed.some((stage) => !REMOVABLE.includes(stage))) throw new Error(`removed may only list ${REMOVABLE.join(' and ')}. The other built-in steps carry a rule the factory depends on.`);
    out.removed = [...new Set(input.removed)];
  }
  for (const pipeline of Object.keys(PIPELINES)) {
    if (input[pipeline] === undefined) continue;
    if (!isObject(input[pipeline])) throw new Error(`${pipeline} must be an object keyed by stage name.`);
    const stages = {};
    for (const [stage, value] of Object.entries(input[pipeline])) {
      const checked = checkStage(pipeline, stage, value, known, ids);
      if (Object.keys(checked).length) stages[stage] = checked;
    }
    if (Object.keys(stages).length) out[pipeline] = stages;
  }
  return out;
}

function merge(base, over = {}) {
  const out = { types: over.types || base.types, readFirst: over.readFirst || base.readFirst, customStages: over.customStages || base.customStages, removed: over.removed || base.removed, maxAttempts: over.maxAttempts || base.maxAttempts, lessons: over.lessons || base.lessons };
  for (const pipeline of Object.keys(PIPELINES)) {
    out[pipeline] = {};
    for (const stage of PIPELINES[pipeline]) out[pipeline][stage] = { ...base[pipeline][stage], ...over[pipeline]?.[stage] };
  }
  for (const { id } of out.customStages) out.stages[id] = { ...base.stages[id], ...over.stages?.[id] };
  return out;
}

// Fills the values that depend on the task types, and drops types that no longer exist.
function finish(workflow) {
  const { types, stages } = workflow;
  const known = (list) => (list || []).filter((type) => types.includes(type));
  stages.reproduce.skipFor = stages.reproduce.skipFor ? known(stages.reproduce.skipFor) : types.filter((type) => type !== 'bug');
  stages.plan.skipFor = known(stages.plan.skipFor);
  stages.verify.skipFor = known(stages.verify.skipFor);
  stages.gates.requireRegression = known(stages.gates.requireRegression);
  for (const pipeline of Object.keys(PIPELINES)) for (const stage of PIPELINES[pipeline]) workflow[pipeline][stage] = { instructions: '', use: [], model: '', ...workflow[pipeline][stage] };
  for (const { id } of workflow.customStages) stages[id] = { instructions: '', use: [], model: '', ...stages[id], skipFor: known(stages[id]?.skipFor) };
  // The issue pipeline in effect: built-in stages without the removed ones, custom steps after their anchor.
  const order = STAGES.filter((stage) => !workflow.removed.includes(stage));
  for (const step of workflow.customStages) {
    let anchor = step.after;
    // A step whose anchor was removed moves up to the nearest earlier stage.
    while (!order.includes(anchor)) anchor = STAGES[STAGES.indexOf(anchor) - 1];
    let at = order.indexOf(anchor) + 1;
    while (workflow.customStages.some((other) => other.id === order[at] && other.after === step.after)) at++;
    order.splice(at, 0, step.id);
  }
  workflow.order = order;
  return workflow;
}

// The verifier judges the regression proof, so a type that needs the proof keeps its verifier.
function checkConsistent(workflow) {
  const clash = workflow.stages.verify.skipFor.find((type) => workflow.stages.gates.requireRegression.includes(type));
  if (clash) throw new Error(`The verifier cannot be skipped for "${clash}": that type still requires the regression proof. Remove "${clash}" from the regression list of the gates stage first.`);
}

function readGlobal() {
  if (!fs.existsSync(workflowPath())) return {};
  return JSON.parse(fs.readFileSync(workflowPath(), 'utf8'));
}

/** Returns the built-in workflow, with nothing overridden. */
export const defaultWorkflow = () => finish(merge(structuredClone(DEFAULTS)));

/** Returns the saved override of a scope: "global" or a project key. */
export function workflowOverride(scope, registry = loadRegistry()) {
  if (scope === 'global') return readGlobal();
  if (!Object.hasOwn(registry.repos, scope)) throw new Error(`Unknown project "${scope}". Registered: ${Object.keys(registry.repos).join(', ') || 'none'}.`);
  return registry.repos[scope].workflow || {};
}

/** Returns the workflow a scope inherits before its own override applies. */
export function inheritedWorkflow(scope) {
  return scope === 'global' ? defaultWorkflow() : finish(merge(structuredClone(DEFAULTS), readGlobal()));
}

/** Returns the workflow in effect: defaults, then the global override, then the project's. */
export function resolveWorkflow(projectKey, registry = loadRegistry()) {
  const global = merge(structuredClone(DEFAULTS), readGlobal());
  const project = projectKey && Object.hasOwn(registry.repos, projectKey) ? registry.repos[projectKey].workflow : null;
  return finish(project ? merge(global, project) : global);
}

/** Validates and saves the override of a scope, replacing the previous one. */
export const saveWorkflow = (scope, input) => withSettings(() => saveWorkflowNow(scope, input));

function saveWorkflowNow(scope, input) {
  const registry = loadRegistry();
  if (scope !== 'global' && !Object.hasOwn(registry.repos, scope)) throw new Error(`Unknown project "${scope}". Registered: ${Object.keys(registry.repos).join(', ') || 'none'}.`);
  const override = checkWorkflow(input, inheritedWorkflow(scope).types, inheritedWorkflow(scope).customStages.map((step) => step.id));
  if (scope === 'global') {
    checkConsistent(finish(merge(structuredClone(DEFAULTS), override)));
    // A project override written for the old types must still hold with the new ones.
    for (const key of Object.keys(registry.repos)) if (registry.repos[key].workflow) checkConsistent(finish(merge(merge(structuredClone(DEFAULTS), override), registry.repos[key].workflow)));
    if (Object.keys(override).length) writeJson(workflowPath(), override);
    else fs.rmSync(workflowPath(), { force: true });
  } else {
    checkConsistent(finish(merge(merge(structuredClone(DEFAULTS), readGlobal()), override)));
    if (Object.keys(override).length) registry.repos[scope].workflow = override;
    else delete registry.repos[scope].workflow;
    writeJson(path.join(factoryRoot(), 'repos.json'), registry);
  }
  return override;
}

/** Returns the workflow a scope would have with the given override, without saving it. */
export function previewWorkflow(scope, input) {
  const override = checkWorkflow(input, inheritedWorkflow(scope).types, inheritedWorkflow(scope).customStages.map((step) => step.id));
  const base = scope === 'global' ? structuredClone(DEFAULTS) : merge(structuredClone(DEFAULTS), readGlobal());
  const workflow = finish(merge(base, override));
  checkConsistent(workflow);
  return workflow;
}

const customRule = (step) => (step.check.kind === 'document'
  ? `${step.check.file} exists in the task's document folder${step.check.headings.length ? ` with the sections: ${step.check.headings.join(', ')}` : ''}.`
  : step.check.kind === 'command'
    ? `The step's check command passed at HEAD on a clean tree: ${step.check.cmd}`
    : 'Nothing is checked. The agent advances when the instructions are done.');

/** Returns the display name of a built-in stage of a pipeline, for text that has no workflow at hand. */
export const builtInTitle = (stage, review = false) => TITLES[review ? 'review' : 'stages'][stage] || stage;

/** Returns the display name of a stage. */
export const stageTitle = (workflow, stage) => workflow.customStages.find((step) => step.id === stage)?.title || TITLES.stages[stage] || stage;

/** Returns what the page needs to draw a workflow: its stages in order, the fields each can set, and its rule. */
export function workflowShape(workflow = defaultWorkflow()) {
  const builtIn = (pipeline, stage) => ({ stage, title: TITLES[pipeline][stage] || stage, fields: [...COMMON_FIELDS, ...(pipeline === 'stages' ? RULE_FIELDS[stage] || [] : [])], rule: EXIT[pipeline][stage], actor: ABOUT[pipeline][stage][0], about: ABOUT[pipeline][stage][1], configurable: pipeline === 'stages' && Boolean(RULE_FIELDS[stage]), custom: false, removable: pipeline === 'stages' && REMOVABLE.includes(stage) });
  const stages = workflow.order.map((stage) => {
    const step = workflow.customStages.find((item) => item.id === stage);
    return step ? { stage, title: step.title, fields: CUSTOM_FIELDS, rule: customRule(step), actor: 'Agent', about: step.about, configurable: true, custom: true, removable: true } : builtIn('stages', stage);
  });
  return { stages, review: REVIEW_STAGES.map((stage) => builtIn('review', stage)), removed: workflow.removed.map((stage) => builtIn('stages', stage)), anchors: ANCHORS.filter((stage) => workflow.order.includes(stage)) };
}

/** Returns true when the stage is switched off for the task type. */
export const skips = (workflow, stage, type) => Boolean(type) && (workflow.stages[stage].skipFor || []).includes(type);

/**
 * Returns the brief of a stage: instructions, files to read, skills and agents, and the exit rule.
 * `state` needs id, kind, stage, type and worktree.
 */
export function stageBrief(state, repo, workflow = resolveWorkflow(repo.key)) {
  const pipeline = state.kind === 'review' ? 'review' : 'stages';
  const stage = workflow[pipeline][state.stage];
  if (!stage) throw new Error(`Stage "${state.stage}" does not exist for ${state.id}.`);
  const fill = (text) => text
    .replaceAll('{id}', state.id)
    .replaceAll('{dir}', issueDir(state.id))
    .replaceAll('{worktree}', state.worktree)
    .replaceAll('{types}', workflow.types.join('|'))
    .replaceAll('{headings}', (workflow.stages.plan.headings || []).map((h) => `"## ${h}"`).join(', '));
  const root = state.worktree && fs.existsSync(state.worktree) ? state.worktree : repo.dir;
  const exists = (file) => within(path.resolve(root, file), root) && fs.existsSync(path.resolve(root, file));
  const use = stage.use
    .filter((entry) => !entry.types || !state.type || entry.types.includes(state.type))
    .map((entry) => ({ ...entry, byPath: entry.ref.includes('/'), missing: entry.ref.includes('/') && !exists(entry.ref) }));
  const skipped = pipeline === 'stages' && state.stage !== 'verify' && skips(workflow, state.stage, state.type);
  const noVerifier = pipeline === 'stages' && state.stage === 'verify' && skips(workflow, 'verify', state.type);
  const step = pipeline === 'stages' ? workflow.customStages.find((item) => item.id === state.stage) : null;
  let rule = step ? customRule(step) : EXIT[pipeline][state.stage];
  if (pipeline === 'stages' && state.stage === 'plan') rule = `plan.md has these sections: ${(stage.headings || []).join(', ') || 'none required'}.`;
  if (pipeline === 'stages' && state.stage === 'gates') rule = `Every gate passed at HEAD on a clean tree.${stage.requireRegression.length ? ` Regression proof is required for: ${stage.requireRegression.join(', ')}.` : ''}`;
  if (pipeline === 'stages' && state.stage === 'verify') rule = noVerifier ? 'pr-body.md and the commits pass their checks. No verifier is required for this type.' : `pr-body.md and the commits pass their checks, and the verifier recorded a passing verdict at HEAD${stage.rerunGates ? ' after re-running every gate' : ''}.`;
  return {
    id: state.id,
    kind: pipeline === 'review' ? 'review' : 'issue',
    stage: state.stage,
    title: pipeline === 'review' ? TITLES.review[state.stage] || state.stage : stageTitle(workflow, state.stage),
    check: step?.check.kind === 'command' ? `factory run ${state.id} ${state.stage}` : null,
    type: state.type || null,
    skipped,
    readFirst: workflow.readFirst.map((file) => ({ file, missing: !exists(file) })),
    lessons: workflow.lessons,
    maxAttempts: workflow.maxAttempts,
    notes: [state.clarifiedAt ? `The user answered your questions or left a note in ${path.join(issueDir(state.id), 'answers.md')}. Read it before anything else.` : '', state.sentBack ? `The user sent this task back at human review: ${state.sentBack.reason} Fix that first.` : '', state.prFeedback ? `The pull request of this task is open and needs changes. The user passed this on from its checks and reviewers; fix it, commit, and take the task through the checks again. Do not push: the user approves the fix first.\n${state.prFeedback.text.split('\n').map((line) => `      ${line}`).join('\n')}` : ''].filter(Boolean),
    use,
    model: stage.model,
    instructions: skipped ? `This stage is off for type ${state.type}. Advance.` : fill(stage.instructions),
    rule,
  };
}

/** Formats a brief as the text "factory next" prints; `problems` are the unmet exit checks. */
export function formatBrief(brief, { problems = null, blocked = null, attempts = null } = {}) {
  const cli = `node '${path.join(codeRoot(), 'bin', 'factory.mjs')}'`;
  const lines = [`${brief.id} · ${brief.kind} · stage ${brief.stage}${brief.title !== brief.stage ? ` (${brief.title})` : ''}${brief.type ? ` · type ${brief.type}` : ''}`, `CLI: ${cli}   (written as "factory" below)`, ''];
  if (blocked) lines.push(`BLOCKED: ${blocked}`, 'Stop and tell the user. The user unblocks the task.', '');
  if (brief.notes.length) lines.push('From the user:', ...brief.notes.map((text) => `  - ${text}`), '');
  if (brief.readFirst.length) {
    lines.push('Read first:');
    for (const r of brief.readFirst) lines.push(r.missing ? `  - MISSING: ${r.file} (configured, not found in the project; tell the user)` : `  - ${r.file}`);
    lines.push('');
  }
  if (brief.lessons.length) lines.push('Lessons from earlier human reviews of this project. Apply every one that fits:', ...brief.lessons.map((text) => `  - ${text}`), '');
  if (brief.use.length && !brief.skipped) {
    lines.push('Use:');
    for (const u of brief.use) {
      if (u.missing) lines.push(`  - MISSING: ${u.ref} (configured ${u.kind}, not found in the project; tell the user)`);
      else if (u.byPath) lines.push(`  - Read and follow ${u.ref} (${u.kind} instructions in the project)`);
      else lines.push(u.kind === 'agent' ? `  - Delegate to the agent "${u.ref}"` : `  - Invoke the skill "${u.ref}"`);
    }
    lines.push('');
  }
  if (brief.model && !brief.skipped) lines.push(`Model for this stage: ${brief.model}`, `  Do this step in a subagent that runs on ${brief.model}: pass it as the model when you delegate. If your session already runs on it, do the step yourself.`, '');
  lines.push('What to do:', `  ${brief.instructions || 'No instructions are written for this step.'}`, '', `Done when: ${brief.rule}`);
  if (brief.check) lines.push(`Run the check with: ${brief.check}`);
  if (problems) {
    lines.push('');
    if (problems.length) lines.push('Still missing:', ...problems.map((p) => `  - ${p}`));
    else lines.push('Nothing is missing.');
  }
  if (attempts?.failed) lines.push('', `Failed attempts at this step: ${attempts.failed} of ${brief.maxAttempts}. At ${brief.maxAttempts} the task stops and waits for the user, so find the cause before running again.`);
  lines.push('', `Then run: factory advance ${brief.id}   and   factory next ${brief.id}`);
  return `${lines.join('\n')}\n`;
}

/** Returns the newest lessons first-in, capped; used when a human review adds one. */
export const withLesson = (lessons, text) => [...lessons.filter((item) => item !== text), text].slice(-MAX_LESSONS);

/** Returns the saved references of a project whose files are gone. */
export function brokenReferences(projectKey, registry = loadRegistry()) {
  const repo = getRepo(projectKey, registry);
  const workflow = resolveWorkflow(projectKey, registry);
  const gone = (file) => !fs.existsSync(path.resolve(repo.dir, file));
  const out = workflow.readFirst.filter(gone).map((file) => `readFirst "${file}"`);
  for (const pipeline of Object.keys(PIPELINES)) {
    for (const stage of pipeline === 'stages' ? workflow.order : PIPELINES[pipeline]) {
      for (const entry of workflow[pipeline][stage].use) if (entry.ref.includes('/') && gone(entry.ref)) out.push(`${pipeline === 'review' ? 'review ' : ''}${stage} ${entry.kind} "${entry.ref}"`);
    }
  }
  return out;
}
