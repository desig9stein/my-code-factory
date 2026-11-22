// Covers the workflow definition, the stage briefs, asset discovery and the installed skill and agent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/factory.mjs', import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-workflow-')));
const ROOT = path.join(tmp, 'data');
const WS = path.join(tmp, 'ws');
const APP = path.join(WS, 'app');
const ID = 'app-5';
const DIR = path.join(ROOT, 'issues', ID);

Object.assign(process.env, {
  FACTORY_ROOT: ROOT,
  FACTORY_WORKSPACE: WS,
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

const { defaultWorkflow, resolveWorkflow, saveWorkflow, stageBrief, formatBrief } = await import('../lib/workflow.mjs');
const { acceptProposals, discoverAssets, dismissProposals, proposeForProject } = await import('../lib/assets.mjs');
const { advance } = await import('../lib/stages.mjs');
const stateModule = await import('../lib/state.mjs');
const { loadState, saveState } = stateModule;
const { getRepo } = await import('../lib/registry.mjs');
const { addVerdict, fileSha256, runRecorded } = await import('../lib/evidence.mjs');

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
function sh(cwd, cmd) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  return r.stdout.trim();
}
const cli = (...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: tmp });
  return { status: r.status, out: r.stdout + r.stderr };
};
const registry = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'repos.json'), 'utf8'));
const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

// Puts the task at a stage with a type, clearing what earlier tests left behind.
function at(stage, type, extra = {}) {
  saveState({ id: ID, kind: 'issue', repo: 'app', issue: 5, title: 'Task', type, stage, stageSince: new Date().toISOString(), worktree: APP, branch: 'task', base: 'main', history: [], ...extra }, { replace: true });
  return loadState(ID);
}
const step = () => advance(loadState(ID), getRepo('app'));
const gate = (actor) => runRecorded(loadState(ID), { name: 'verify', kind: 'gate', cmd: 'true', cwd: APP, actor });

before(() => {
  const remote = path.join(tmp, 'app.git');
  fs.mkdirSync(APP, { recursive: true });
  sh(tmp, `git init -q --bare -b main "${remote}"`);
  sh(APP, 'git init -q -b main');
  write(path.join(APP, 'README.md'), 'app');
  sh(APP, `git add -A && git commit -q -m "chore(repo): seed" && git remote add origin "${remote}" && git push -q origin main && git remote set-head origin main`);
  sh(APP, 'git checkout -q -b task');
  write(path.join(APP, 'AGENTS.md'), '# Agents\n\nRun `npm run lint` and `npm test` before a commit. `test:watch` is for local use.\n');
  write(path.join(APP, 'package.json'), JSON.stringify({ name: 'app', scripts: { lint: 'true', test: 'true', 'test:watch': 'true', start: 'true' } }));
  write(path.join(APP, '.github/agents/bug-fixing-implementer-agent.md'), skill('bug-fixing-implementer-agent', 'Fixes bugs.'));
  write(path.join(APP, '.github/agents/README.md'), '# Agents');
  write(path.join(APP, '.agents/skills/review-component-pr/SKILL.md'), skill('review-component-pr', '"Review checklist for component pull requests."'));
  write(path.join(APP, '.claude/skills/review-component-pr/SKILL.md'), skill('review-component-pr', '"Review checklist for component pull requests."'));
  write(path.join(APP, '.github/skills/review-component-pr/SKILL.md'), `${skill('review-component-pr', 'Another text.')}changed\n`);
  write(path.join(APP, '.github/skills/folded/SKILL.md'), '---\nname: folded\ndescription: >\n  First line\n  second line.\n---\n');
  write(path.join(APP, 'skills/app-grids/SKILL.md'), skill('app-grids', 'Review and verify grids for library users.'));
  write(path.join(APP, '.github/PULL_REQUEST_TEMPLATE.md'), '<!-- ## Hidden -->\n## Description\n\n## How to test\n\n## Checklist:\n- [ ] done\n');
  sh(APP, 'git add -A && git commit -q -m "fix(app): add the agent files"');
  write(path.join(ROOT, 'repos.json'), JSON.stringify({
    defaults: { maxCommits: 3, conventionalCommits: true },
    repos: {
      app: { dir: 'app', remote: 'acme/app', baseBranch: 'main', install: '', gates: [{ name: 'verify', cmd: 'true' }] },
      other: { dir: 'app', remote: 'acme/app', baseBranch: 'main', install: '', gates: [] },
    },
  }));
});
beforeEach(() => {
  saveWorkflow('global', {});
  saveWorkflow('app', {});
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('without a saved workflow the defaults hold: four types, six plan sections, reproduce only for bugs', () => {
  const w = resolveWorkflow('app');
  assert.deepEqual(w, defaultWorkflow());
  assert.deepEqual(w.types, ['bug', 'feature', 'docs', 'chore']);
  assert.deepEqual(w.stages.plan.headings, ['Acceptance criteria', 'Files', 'Test boundaries', 'Tests', 'Consumer impact', 'Changelog']);
  assert.equal(w.maxAttempts, 5);
  assert.deepEqual(w.lessons, []);
  assert.deepEqual(w.stages.reproduce.skipFor, ['feature', 'docs', 'chore']);
  assert.deepEqual(w.stages.gates.requireRegression, ['bug']);
  assert.deepEqual(w.stages.verify.use, [{ ref: 'factory-verifier', kind: 'agent' }]);
  assert.equal(fs.existsSync(path.join(ROOT, 'workflow.json')), false);
});

test('a project override wins over the global value, which wins over the default', () => {
  saveWorkflow('global', { stages: { plan: { headings: ['Files'] } } });
  saveWorkflow('app', { stages: { plan: { headings: ['Risks'] } } });
  assert.deepEqual(resolveWorkflow('app').stages.plan.headings, ['Risks']);
  assert.deepEqual(resolveWorkflow('other').stages.plan.headings, ['Files']);
  assert.deepEqual(defaultWorkflow().stages.plan.headings.length, 6);
  assert.deepEqual(registry().repos.app.workflow, { stages: { plan: { headings: ['Risks'] } } });
});

test('plan is skipped for a docs task when skipFor lists docs, and history records the skip', () => {
  saveWorkflow('global', { stages: { plan: { skipFor: ['docs'] } } });
  at('plan', 'docs');
  const r = step();
  assert.equal(r.moved, true, r.problems.join('\n'));
  assert.equal(loadState(ID).stage, 'implement');
  assert.equal(loadState(ID).history.at(-1).note, 'Skipped: plan is off for type docs.');
  at('plan', 'feature');
  assert.deepEqual(step().problems, ['plan.md is missing.']);
});

test('plan requires the configured sections and names a missing one', () => {
  saveWorkflow('app', { stages: { plan: { headings: ['Files', 'Risks'] } } });
  at('plan', 'feature');
  write(path.join(DIR, 'plan.md'), '## Files\n\n- a\n');
  assert.deepEqual(step().problems, ['plan.md needs a "## Risks" section.']);
  write(path.join(DIR, 'plan.md'), '## Files\n\n- a\n\n## Risks\n\nNone.\n');
  assert.equal(step().moved, true);
});

test('a feature task needs the regression proof when requireRegression lists feature', () => {
  at('gates', 'feature');
  gate('implementer');
  assert.equal(step().moved, true);
  saveWorkflow('global', { stages: { gates: { requireRegression: ['bug', 'feature'] } } });
  at('gates', 'feature');
  const r = step();
  assert.equal(r.moved, false);
  assert.match(r.problems.join('\n'), /Regression proof is missing at HEAD/);
});

test('verify passes without verifier gate runs when rerunGates is false, and still needs the verdict', () => {
  write(path.join(DIR, 'pr-body.md'), 'Closes #5.\n\n## Summary\n\nAdds the agent files.\n');
  at('verify', 'feature');
  assert.match(step().problems.join('\n'), /The verifier has no passing run of "verify"/);
  saveWorkflow('app', { stages: { verify: { rerunGates: false } } });
  const problems = step().problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^No verifier verdict at HEAD\. An independent verifier records it with/);
  addVerdict(loadState(ID), { verdict: 'pass', report: 'ok', prBodySha256: fileSha256(path.join(DIR, 'pr-body.md')) });
  assert.equal(step().moved, true);
  assert.equal(loadState(ID).stage, 'ready');
});

test('a type with the verifier switched off still needs a valid PR body', () => {
  saveWorkflow('global', { stages: { verify: { skipFor: ['docs'] } } });
  at('verify', 'docs');
  fs.rmSync(path.join(DIR, 'pr-body.md'));
  assert.match(step().problems.join('\n'), /pr-body\.md is missing/);
  write(path.join(DIR, 'pr-body.md'), 'Closes #5.\n');
  assert.equal(step().moved, true);
  assert.equal(loadState(ID).history.at(-1).note, 'Verifier pass skipped: off for type docs.');
});

test('saving rejects an unknown stage', () => {
  assert.throws(() => saveWorkflow('global', { stages: { deploy: { instructions: 'x' } } }), /"deploy" is not a stage of the issue workflow\. Valid stages: intake, triage/);
  assert.throws(() => saveWorkflow('global', { review: { plan: {} } }), /"plan" is not a stage of the review workflow/);
});

test('saving rejects a field the stage does not have, because its exit rule is fixed', () => {
  assert.throws(() => saveWorkflow('global', { stages: { implement: { skipFor: ['docs'] } } }), /stages\.implement has no field "skipFor"\. Its exit rule is fixed\. Fields you can set: instructions, use, model/);
  assert.throws(() => saveWorkflow('global', { stages: { ready: { skipFor: ['docs'] } } }), /stages\.ready has no field "skipFor"/);
  assert.throws(() => saveWorkflow('global', { approval: false }), /"approval" is not a workflow field/);
});

test('saving rejects a task type that does not exist', () => {
  assert.throws(() => saveWorkflow('global', { stages: { plan: { skipFor: ['spike'] } } }), /stages\.plan\.skipFor names "spike", which is not a task type\. Valid types: bug, feature, docs, chore/);
  saveWorkflow('global', { types: ['bug', 'spike'], stages: { plan: { skipFor: ['spike'] } } });
  assert.deepEqual(resolveWorkflow('app').stages.reproduce.skipFor, ['spike']);
});

test('saving rejects a reference that leaves the project or is not a name', () => {
  const use = (ref) => () => saveWorkflow('app', { stages: { implement: { use: [{ ref, kind: 'agent' }] } } });
  assert.throws(use('../outside/agent.md'), /must be a Markdown file path relative to the project/);
  assert.throws(use('/etc/agent.md'), /must be a Markdown file path relative to the project/);
  assert.throws(use('bad name'), /is not a skill or agent name/);
  assert.throws(() => saveWorkflow('app', { stages: { implement: { use: [{ ref: 'x', kind: 'tool' }] } } }), /kind must be "skill" or "agent"/);
});

test('saving refuses to switch the verifier off for a type that still requires regression proof', () => {
  assert.throws(() => saveWorkflow('global', { stages: { verify: { skipFor: ['bug'] } } }), /The verifier cannot be skipped for "bug": that type still requires the regression proof/);
  saveWorkflow('global', { stages: { verify: { skipFor: ['bug'] }, gates: { requireRegression: [] } } });
  assert.deepEqual(resolveWorkflow('app').stages.verify.skipFor, ['bug']);
});

test('fixed rules ignore the configuration: ready still waits for the user with every check switched off', () => {
  saveWorkflow('global', { stages: { reproduce: { skipFor: ['bug', 'feature', 'docs', 'chore'] }, plan: { skipFor: ['docs'] }, verify: { skipFor: ['docs'], rerunGates: false }, gates: { requireRegression: [] } } });
  at('ready', 'docs');
  const r = step();
  assert.equal(r.moved, false);
  assert.match(r.problems[0], /Waiting for the user/);
  at('implement', 'docs');
  write(path.join(APP, 'stray.txt'), 'x');
  assert.match(step().problems.join('\n'), /uncommitted changes/);
  fs.rmSync(path.join(APP, 'stray.txt'));
});

test('discovery reads name and description from skills and agents in every known folder', () => {
  const assets = discoverAssets(APP);
  assert.deepEqual(assets.agents.map((a) => [a.name, a.path, a.ref, a.invocable]), [['bug-fixing-implementer-agent', '.github/agents/bug-fixing-implementer-agent.md', '.github/agents/bug-fixing-implementer-agent.md', false]]);
  assert.deepEqual(assets.skills.map((s) => s.name), ['folded', 'review-component-pr']);
  assert.equal(assets.skills[0].description, 'First line second line.');
  assert.equal(assets.skills[1].description, 'Review checklist for component pull requests.');
  assert.deepEqual(assets.instructions, ['AGENTS.md']);
  assert.equal(assets.prTemplate.toLowerCase(), '.github/pull_request_template.md');
});

test('mirrored copies are listed once, preferring .claude, and copies that differ are flagged', () => {
  const review = discoverAssets(APP).skills.find((s) => s.name === 'review-component-pr');
  assert.equal(review.path, '.claude/skills/review-component-pr/SKILL.md');
  assert.equal(review.ref, 'review-component-pr');
  assert.equal(review.invocable, true);
  assert.equal(review.copies.length, 3);
  assert.equal(review.differs, true);
});

test('a top-level skills entry is a product skill and gets no stage proposal', () => {
  const { assets, proposals } = proposeForProject('app');
  assert.deepEqual(assets.products.map((p) => p.name), ['app-grids']);
  assert.equal(proposals.some((p) => p.id.includes('app-grids')), false);
});

test('proposes the bug implementer for implement limited to bugs, and a review skill for draft and verify', () => {
  const { proposals } = proposeForProject('app');
  const implement = proposals.find((p) => p.stage === 'implement');
  assert.deepEqual(implement.use, { ref: '.github/agents/bug-fixing-implementer-agent.md', kind: 'agent', types: ['bug'] });
  assert.deepEqual(proposals.filter((p) => p.use?.ref === 'review-component-pr').map((p) => `${p.pipeline}.${p.stage}`), ['review.draft', 'stages.verify']);
  assert.match(proposals.find((p) => p.use?.ref === 'review-component-pr').note, /Copies differ/);
  assert.match(implement.effect, /When a bug task of app reaches the "implement" step, the agent is told to read \.github\/agents\/bug-fixing-implementer-agent\.md and work by it.*Other task types are not affected\. No file in the repository changes\./);
  assert.match(implement.undo, /Open the "implement" step for app and remove it under "Skills and agents"/);
  assert.match(proposals.find((p) => p.pipeline === 'review').effect, /When a pull request review of app reaches the "draft" step, the agent is told to invoke the skill "review-component-pr"/);
});

test('proposes the PR template headings, the instruction file and the scripts it names', () => {
  const { proposals } = proposeForProject('app');
  assert.deepEqual(proposals.find((p) => p.action === 'prBody').sections, ['Description', 'How to test', 'Checklist']);
  assert.deepEqual(proposals.find((p) => p.action === 'readFirst').files, ['AGENTS.md']);
  assert.deepEqual(proposals.filter((p) => p.action === 'gate').map((p) => p.gate), [{ name: 'lint', cmd: 'npm run lint' }, { name: 'test', cmd: 'npm test' }]);
  assert.match(proposals.find((p) => p.id === 'gate:lint').effect, /Every app task must pass "npm run lint" at the "gates" step/);
  assert.match(proposals.find((p) => p.action === 'prBody').note, /optional in most pull requests/);
  for (const p of proposals) assert.ok(p.effect && p.undo, p.id);
});

test('accepting proposals applies them, and they are not offered again', () => {
  const { proposals } = proposeForProject('app');
  const ids = proposals.filter((p) => p.stage === 'implement' || ['readFirst', 'prBody'].includes(p.action) || p.id === 'gate:lint').map((p) => p.id);
  assert.deepEqual(acceptProposals('app', ids).sort(), [...ids].sort());
  const app = registry().repos.app;
  assert.deepEqual(app.workflow.readFirst, ['AGENTS.md']);
  assert.deepEqual(app.workflow.stages.implement.use, [{ ref: '.github/agents/bug-fixing-implementer-agent.md', kind: 'agent', types: ['bug'] }]);
  assert.deepEqual(app.prBody.requiredSections, ['Description', 'How to test', 'Checklist']);
  assert.deepEqual(app.gates.map((g) => g.name), ['verify', 'lint']);
  const left = proposeForProject('app').proposals.map((p) => p.id);
  assert.equal(ids.some((id) => left.includes(id)), false);
  assert.throws(() => acceptProposals('app', [ids[0]]), /No open proposal/);
  dismissProposals('app', ['gate:test']);
  assert.equal(proposeForProject('app').proposals.some((p) => p.id === 'gate:test'), false);
});

test('the brief names a path reference as a file to read, and only the entries for the task type', () => {
  saveWorkflow('app', { readFirst: ['AGENTS.md'], stages: { implement: { model: 'opus', use: [{ ref: '.github/agents/bug-fixing-implementer-agent.md', kind: 'agent', types: ['bug'] }, { ref: 'frontend-design', kind: 'skill', types: ['feature'] }] } } });
  const bug = formatBrief(stageBrief(at('implement', 'bug'), getRepo('app')));
  assert.match(bug, /Read first:\n {2}- AGENTS\.md/);
  assert.match(bug, /Read and follow \.github\/agents\/bug-fixing-implementer-agent\.md \(agent instructions in the project\)/);
  assert.doesNotMatch(bug, /frontend-design/);
  assert.match(bug, /Model for this stage: opus/);
  const feature = formatBrief(stageBrief(at('implement', 'feature'), getRepo('app')));
  assert.match(feature, /Invoke the skill "frontend-design"/);
  assert.doesNotMatch(feature, /bug-fixing/);
});

test('factory next prints the instructions, the verifier agent and what is still missing', () => {
  saveWorkflow('app', { stages: { triage: { instructions: 'Triage {id} into {dir}/triage.md as {types}.' } } });
  at('triage', undefined);
  const triage = cli('next', ID);
  assert.equal(triage.status, 0, triage.out);
  assert.match(triage.out, new RegExp(`Triage app-5 into ${DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/triage\\.md as bug\\|feature\\|docs\\|chore\\.`));
  assert.match(triage.out, /Still missing:\n {2}- triage\.md is missing/);
  assert.match(triage.out, /Then run: factory advance app-5/);
  at('verify', 'feature');
  const verify = cli('next', ID);
  assert.match(verify.out, /Delegate to the agent "factory-verifier"/);
  assert.match(verify.out, /Done when: .*the verifier recorded a passing verdict at HEAD after re-running every gate/);
  assert.equal(loadState(ID).stage, 'verify');
  assert.match(cli('status', ID).out, /Next step: factory next app-5/);
});

test('a blocked task tells the agent to stop', () => {
  at('plan', 'feature', { blocked: { reason: 'The issue is unclear.', at: new Date().toISOString() } });
  assert.match(cli('next', ID).out, /BLOCKED: The issue is unclear\.\nStop and tell the user/);
});

test('doctor and the brief report a saved reference whose file is gone', () => {
  saveWorkflow('app', { readFirst: ['GONE.md'], stages: { implement: { use: [{ ref: '.github/agents/gone.md', kind: 'agent' }] } } });
  const doctor = cli('doctor');
  assert.equal(doctor.status, 1);
  assert.match(doctor.out, /app: workflow readFirst "GONE\.md" does not exist/);
  assert.match(doctor.out, /app: workflow implement agent "\.github\/agents\/gone\.md" does not exist/);
  const brief = formatBrief(stageBrief(at('implement', 'bug'), getRepo('app')));
  assert.match(brief, /MISSING: GONE\.md/);
  assert.match(brief, /MISSING: \.github\/agents\/gone\.md \(configured agent/);
});

test('hooks install writes the factory skill and the verifier agent, and is a no-op the second time', () => {
  const dir = path.join(tmp, 'claude');
  const first = cli('hooks', '--install');
  assert.equal(first.status, 0, first.out);
  const skillFile = path.join(dir, 'skills', 'factory', 'SKILL.md');
  const agentFile = path.join(dir, 'agents', 'factory-verifier.md');
  assert.match(fs.readFileSync(skillFile, 'utf8'), /^---\nname: factory\n/);
  assert.match(fs.readFileSync(skillFile, 'utf8'), /bin\/factory\.mjs'`/);
  assert.match(fs.readFileSync(agentFile, 'utf8'), /^---\nname: factory-verifier\n/);
  write(agentFile, 'edited by hand');
  const second = cli('hooks', '--install');
  assert.match(second.out, /SKILL\.md is already current/);
  assert.match(second.out, /factory-verifier\.md\. Previous version: .*factory-verifier\.md\.bak/);
  assert.equal(fs.readFileSync(`${agentFile}.bak`, 'utf8'), 'edited by hand');
  assert.match(cli('hooks', '--install').out, /factory-verifier\.md is already current/);
});

const { workflowShape } = await import('../lib/workflow.mjs');
const { modelChoices } = await import('../lib/providers.mjs');
const { userAssets } = await import('../lib/assets.mjs');
const design = { id: 'design-review', title: 'Design review', about: 'Checks the design.', after: 'plan', check: { kind: 'document', file: 'design.md', headings: ['Decision'] } };

test('a removed plan step leaves the pipeline, and reproduce continues at implement', () => {
  saveWorkflow('global', { removed: ['plan'] });
  assert.deepEqual(resolveWorkflow('app').order, ['intake', 'triage', 'reproduce', 'implement', 'gates', 'verify', 'ready', 'approved', 'pr-opened']);
  at('reproduce', 'feature');
  assert.equal(step().moved, true);
  assert.equal(loadState(ID).stage, 'implement');
  assert.deepEqual(workflowShape(resolveWorkflow('app')).removed.map((s) => s.stage), ['plan']);
});

test('only reproduce and plan can be removed', () => {
  assert.throws(() => saveWorkflow('global', { removed: ['gates'] }), /removed may only list reproduce and plan/);
  assert.throws(() => saveWorkflow('global', { removed: ['ready'] }), /removed may only list reproduce and plan/);
});

test('an added step sits after its anchor and holds the task until its document has the sections', () => {
  saveWorkflow('global', { customStages: [design], stages: { 'design-review': { instructions: 'Write {dir}/design.md.', use: [{ ref: 'design:design-critique', kind: 'skill' }] } } });
  assert.deepEqual(resolveWorkflow('app').order.slice(3, 6), ['plan', 'design-review', 'implement']);
  at('plan', 'feature');
  write(path.join(DIR, 'plan.md'), '## Acceptance criteria\n\n- It works.\n\n## Files\n\n## Test boundaries\n\n## Tests\n\n## Consumer impact\n\n## Changelog\n');
  assert.equal(step().moved, true);
  assert.equal(loadState(ID).stage, 'design-review');
  assert.match(step().problems[0], /design\.md is missing or empty/);
  write(path.join(DIR, 'design.md'), 'Looks fine.\n');
  assert.deepEqual(step().problems, ['design.md needs a "## Decision" section.']);
  write(path.join(DIR, 'design.md'), '## Decision\n\nApproved.\n');
  assert.equal(step().moved, true);
  assert.equal(loadState(ID).stage, 'implement');
  const brief = cli('next', ID);
  assert.equal(brief.status, 0, brief.out);
});

test('the brief of an added step carries its name, instructions, skill and check', () => {
  saveWorkflow('global', { customStages: [design], stages: { 'design-review': { instructions: 'Write {dir}/design.md.', use: [{ ref: 'design:design-critique', kind: 'skill' }] } } });
  const text = formatBrief(stageBrief(at('design-review', 'feature'), getRepo('app')));
  assert.match(text, /stage design-review \(Design review\)/);
  assert.match(text, /Invoke the skill "design:design-critique"/);
  assert.match(text, /Done when: design\.md exists in the task's document folder with the sections: Decision\./);
});

test('an added step with a command check needs a passing run of that command at HEAD', () => {
  saveWorkflow('app', { customStages: [{ id: 'a11y', title: 'Accessibility', about: '', after: 'gates', check: { kind: 'command', cmd: 'true' } }] });
  assert.deepEqual(resolveWorkflow('app').order.slice(5, 8), ['gates', 'a11y', 'verify']);
  at('a11y', 'feature');
  assert.match(step().problems[0], /The check of step "a11y" has not run\. Run "factory run app-5 a11y"/);
  const run = cli('run', ID, 'a11y');
  assert.equal(run.status, 0, run.out);
  assert.equal(step().moved, true);
  assert.equal(loadState(ID).stage, 'verify');
  assert.match(cli('run', ID, 'a11y', '--', 'false').out, /always runs the command configured on the Workflow page/);
});

test('a moved HEAD sends an added step that follows the checks back to gates', () => {
  saveWorkflow('app', { customStages: [{ id: 'a11y', title: 'Accessibility', about: '', after: 'gates', check: { kind: 'none' } }] });
  at('a11y', 'feature', { gatesSha: '0'.repeat(40) });
  assert.equal(loadState(ID).stage, 'a11y');
  const { sync } = stateModule;
  assert.equal(sync(loadState(ID)).stage, 'gates');
});

test('a task in a step that was deleted continues after the last stage that still exists', () => {
  at('design-review', 'feature', { history: [{ stage: 'plan', at: 'x', note: '' }, { stage: 'design-review', at: 'x', note: '' }] });
  const r = step();
  assert.equal(r.moved, true, r.problems.join('\n'));
  assert.equal(loadState(ID).stage, 'implement');
  assert.equal(loadState(ID).history.at(-1).note, 'Skipped: design-review was removed from the workflow.');
});

test('an added step is rejected when it reuses a factory name, sits after the human review, or exceeds the limit', () => {
  const add = (step) => () => saveWorkflow('global', { customStages: [{ ...design, ...step }] });
  assert.throws(add({ id: 'gates' }), /Step id "gates" is already used by the factory/);
  assert.throws(add({ id: 'Design Review' }), /is not valid\. Use 2 to 24 lowercase letters/);
  assert.throws(add({ after: 'ready' }), /cannot go after "ready"\. A step goes after one of: triage, reproduce, plan, implement, gates, verify\. Steps after the human review are fixed/);
  assert.throws(add({ check: { kind: 'document', file: 'verify.md' } }), /verify\.md are written by the factory/);
  assert.throws(add({ check: { kind: 'command', cmd: 'a\nb' } }), /needs a check command: one line/);
  assert.throws(() => saveWorkflow('global', { customStages: Array.from({ length: 7 }, (_, n) => ({ ...design, id: `step-${n}` })) }), /at most 6 steps/);
  assert.throws(() => saveWorkflow('global', { stages: { 'design-review': { instructions: 'x' } } }), /"design-review" is not a stage of the issue workflow/);
});

test('steps carry one display name each, and the ready stage is "your review" with its fixed rule', () => {
  const shape = workflowShape(resolveWorkflow('app'));
  const ready = shape.stages.find((s) => s.stage === 'ready');
  assert.deepEqual([ready.title, ready.actor, ready.removable, ready.configurable], ['your review', 'You', false, false]);
  assert.deepEqual(shape.stages.filter((s) => s.title !== s.stage).map((s) => [s.stage, s.title]), [['gates', 'checks'], ['ready', 'your review'], ['approved', 'open the PR'], ['pr-opened', 'PR opened']]);
  assert.equal(shape.review.find((s) => s.stage === 'approved').title, 'post the review');
  assert.equal(shape.review.find((s) => s.stage === 'ready').title, 'your review');
  assert.match(formatBrief(stageBrief(at('ready', 'feature'), getRepo('app'))), /stage ready \(your review\)/);
});

test('every step an agent works in has a default model, and factory-only steps have none', () => {
  const w = defaultWorkflow();
  const of = (pipeline) => Object.fromEntries(Object.entries(w[pipeline]).map(([stage, value]) => [stage, value.model]));
  assert.deepEqual(of('stages'), { intake: '', triage: 'opus', reproduce: 'sonnet', plan: 'fable', implement: 'opus', gates: 'sonnet', verify: 'fable', ready: 'sonnet', approved: 'haiku', 'pr-opened': '' });
  assert.deepEqual(of('review'), { intake: '', checks: 'sonnet', draft: 'opus', ready: 'sonnet', approved: 'haiku', posted: '' });
  const known = modelChoices().models.map((m) => m.id);
  for (const model of [...Object.values(of('stages')), ...Object.values(of('review'))]) assert.ok(model === '' || known.includes(model), model);
  const brief = formatBrief(stageBrief(at('plan', 'feature'), getRepo('app')));
  assert.match(brief, /Model for this stage: fable\n {2}Do this step in a subagent that runs on fable/);
  saveWorkflow('app', { stages: { plan: { model: '' } } });
  assert.doesNotMatch(formatBrief(stageBrief(at('plan', 'feature'), getRepo('app'))), /Model for this stage/);
});

test('the model list names the Claude Code model families', () => {
  const choices = modelChoices();
  assert.equal(choices.provider, 'claude');
  assert.deepEqual(choices.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  saveWorkflow('app', { stages: { implement: { model: 'sonnet' } } });
  assert.match(formatBrief(stageBrief(at('implement', 'feature'), getRepo('app'))), /Model for this stage: sonnet/);
});

test('the user skill list includes plugin skills with their descriptions', () => {
  const dir = path.join(tmp, 'claude');
  write(path.join(dir, 'skills', 'mine', 'SKILL.md'), skill('mine', 'My own skill.'));
  write(path.join(dir, 'plugins', 'synced', 'abc', 'design', 'skills', 'ux-copy', 'SKILL.md'), skill('ux-copy', 'Writes UX copy.'));
  write(path.join(dir, 'plugins', 'synced', 'abc', 'design~g2', 'skills', 'ux-copy', 'SKILL.md'), skill('ux-copy', 'Writes UX copy.'));
  const { skills } = userAssets();
  assert.deepEqual(skills.find((s) => s.name === 'mine'), { name: 'mine', description: 'My own skill.' });
  assert.deepEqual(skills.find((s) => s.name === 'design:ux-copy'), { name: 'design:ux-copy', description: 'Writes UX copy.' });
  assert.equal(skills.filter((s) => s.name.endsWith(':ux-copy')).length, 1);
});

const { attempts, capAttempts, sendBack, approvalKey } = await import('../lib/stages.mjs');
const { proposeGlobal } = await import('../lib/assets.mjs');
const { startServer } = await import('../lib/server.mjs');
const failGate = () => runRecorded(loadState(ID), { name: 'verify', kind: 'gate', cmd: 'false', cwd: APP });

test('a task stops for a person after the limit of failed check runs at one step', () => {
  saveWorkflow('global', { maxAttempts: 3 });
  at('gates', 'feature');
  failGate(); failGate();
  assert.deepEqual([attempts(loadState(ID)).failed, attempts(loadState(ID)).over], [2, false]);
  assert.match(step().problems[0], /Gate "verify" is stale at HEAD/);
  failGate();
  const r = step();
  assert.equal(r.moved, false);
  assert.match(r.problems[0], /Blocked: 3 failed check runs at "gates"; the limit is 3\. A person should look before more attempts\./);
  assert.match(loadState(ID).blocked.reason, /3 failed check runs/);
  assert.match(cli('next', ID).out, /BLOCKED: 3 failed check runs/);
});

test('unblocking starts the count again', () => {
  saveWorkflow('global', { maxAttempts: 3 });
  assert.equal(cli('unblock', ID).status, 0);
  assert.equal(attempts(loadState(ID)).failed, 0);
  assert.match(step().problems[0], /Gate "verify" is stale at HEAD/);
  assert.equal(loadState(ID).blocked, null);
});

test('running a failing check at the limit says the task is blocked', () => {
  saveWorkflow('app', { maxAttempts: 2, customStages: [{ id: 'a11y', title: 'Accessibility', about: '', after: 'gates', check: { kind: 'command', cmd: 'false' } }] });
  at('a11y', 'feature');
  assert.doesNotMatch(cli('run', ID, 'a11y').out, /BLOCKED/);
  assert.match(cli('next', ID).out, /Failed attempts at this step: 1 of 2\./);
  assert.match(cli('run', ID, 'a11y').out, /BLOCKED: 2 failed check runs at "a11y"; the limit is 2\..* Stop and tell the user\./);
});

test('failed verifier verdicts count across the task, whatever step it is in', () => {
  saveWorkflow('global', { maxAttempts: 2 });
  at('gates', 'feature', { attemptsResetAt: new Date().toISOString() });
  addVerdict(loadState(ID), { verdict: 'fail', report: 'no', prBodySha256: null });
  assert.equal(capAttempts(loadState(ID)), null);
  addVerdict(loadState(ID), { verdict: 'fail', report: 'no', prBodySha256: null });
  assert.match(capAttempts(loadState(ID)), /2 failed verifier verdicts on this task; the limit is 2/);
});

test('the attempt limit and lessons are validated', () => {
  assert.throws(() => saveWorkflow('global', { maxAttempts: 0 }), /maxAttempts must be a whole number from 1 to 20, got 0/);
  assert.throws(() => saveWorkflow('global', { maxAttempts: 2.5 }), /maxAttempts must be a whole number/);
  assert.throws(() => saveWorkflow('global', { lessons: ['a\nb'] }), /lessons must be at most 20 entries, each one line/);
});

test('a task at human review can be sent back with a reason, and its lesson reaches later briefs', () => {
  at('ready', 'feature', { gatesSha: sh(APP, 'git rev-parse HEAD'), approvedSha: 'y' });
  assert.throws(() => sendBack(loadState(ID), getRepo('app'), { reason: ' ' }), /needs a reason/);
  sendBack(loadState(ID), getRepo('app'), { reason: 'The option was removed.', lesson: 'Never remove a public option without a deprecation.' });
  const state = loadState(ID);
  assert.deepEqual([state.stage, state.gatesSha, state.approvedSha], ['implement', null, null]);
  assert.equal(state.history.at(-1).note, 'Sent back at human review: The option was removed.');
  assert.deepEqual(registry().repos.app.workflow.lessons, ['Never remove a public option without a deprecation.']);
  assert.match(formatBrief(stageBrief(state, getRepo('app'))), /Lessons from earlier human reviews of this project\. Apply every one that fits:\n {2}- Never remove a public option without a deprecation\./);
  assert.throws(() => sendBack(loadState(ID), getRepo('app'), { reason: 'again' }), /is at "implement", not at human review/);
  assert.equal(cli('reject', ID, '--reason', 'x').status, 1);
});

test('the server sends a task back only with the token and the version the board showed', async () => {
  const state = at('ready', 'feature');
  const server = await startServer(0, { pairing: false, followEvery: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = /__factoryToken="([0-9a-f]{32})"/.exec(await (await fetch(`${base}/`)).text())[1];
    const post = (headers, body) => fetch(`${base}/api/reject`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post({}, { id: ID, key: approvalKey(state), reason: 'x' })).status, 403);
    assert.equal((await post({ 'x-factory-token': token }, { id: ID, key: 'stale', reason: 'x' })).status, 409);
    assert.equal((await post({ 'x-factory-token': token }, { id: ID, key: approvalKey(state), reason: '' })).status, 400);
    assert.equal((await post({ 'x-factory-token': token }, { id: ID, key: approvalKey(state), reason: 'Wrong fix.' })).status, 200);
    assert.equal(loadState(ID).stage, 'implement');
  } finally {
    server.close();
  }
});

test('the default instructions ask for a failing signal first, test-first work and a two-part verification', () => {
  const w = defaultWorkflow();
  assert.match(w.stages.reproduce.instructions, /Build a pass\/fail signal that fails because of this bug.*a failing test at the public boundary/);
  assert.match(w.stages.implement.instructions, /write one failing test, then only the code that makes it pass/);
  assert.match(w.stages.verify.instructions, /judges two things separately: standards .* and intent/);
  assert.match(w.stages.verify.instructions, /the evidence \(output or a test run before and after\), and the merge risk/);
  cli('hooks', '--install');
  assert.match(fs.readFileSync(path.join(tmp, 'claude', 'agents', 'factory-verifier.md'), 'utf8'), /- Standards: .*\n {3}- Intent: /);
});

test('a glossary in the repository is suggested as a file to read first', () => {
  write(path.join(APP, 'GLOSSARY.md'), '# Glossary\n');
  sh(APP, 'git add -A && git commit -q -m "docs(app): add the glossary"');
  assert.deepEqual(proposeForProject('app').proposals.find((p) => p.action === 'readFirst').files, ['AGENTS.md', 'GLOSSARY.md']);
});

test('recommended skills are named with their install command until they are installed', () => {
  const { recommended, proposals } = proposeGlobal();
  assert.equal(recommended.installed, false);
  assert.equal(recommended.license, 'MIT');
  assert.deepEqual(proposals, []);
  assert.deepEqual(recommended.items.map((i) => `${i.skill}@${i.pipeline === 'review' ? 'review.' : ''}${i.stage}`), ['diagnosing-bugs@reproduce', 'tdd@implement', 'research@plan', 'code-review@verify', 'pr@verify', 'code-review@review.draft']);
});

test('installed recommended skills are suggested for their steps and applied to the shared workflow', () => {
  // The real layout: a version folder, category folders, and a manifest that lists the skills it exposes.
  const root = path.join(tmp, 'claude', 'plugins', 'cache', 'claude-plugins-official', 'mattpocock-skills', '1.3.1');
  for (const name of ['diagnosing-bugs', 'tdd', 'code-review']) write(path.join(root, 'skills', 'engineering', name, 'SKILL.md'), skill(name, 'x'));
  write(path.join(root, 'skills', 'in-progress', 'research', 'SKILL.md'), skill('research', 'Not exposed.'));
  write(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'mattpocock-skills', skills: ['./skills/engineering/diagnosing-bugs', './skills/engineering/tdd', './skills/engineering/code-review'] }));
  write(path.join(tmp, 'claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'mattpocock-skills@claude-plugins-official': [{ installPath: root, version: '1.3.1' }] } }));
  assert.equal(userAssets().skills.some((s) => s.name === 'mattpocock-skills:research' || s.name.startsWith('1.3.1')), false);
  const { recommended, proposals } = proposeGlobal();
  assert.equal(recommended.installed, true);
  assert.deepEqual(proposals.map((p) => [p.pipeline, p.stage, p.use.ref, p.use.types]), [['stages', 'reproduce', 'mattpocock-skills:diagnosing-bugs', ['bug']], ['stages', 'implement', 'mattpocock-skills:tdd', undefined], ['stages', 'verify', 'mattpocock-skills:code-review', undefined], ['review', 'draft', 'mattpocock-skills:code-review', undefined]]);
  assert.match(proposals[0].effect, /When a bug task of any project reaches the "reproduce" step, the agent is told to invoke the skill "mattpocock-skills:diagnosing-bugs"/);
  acceptProposals('global', [proposals[1].id, proposals[2].id]);
  const w = resolveWorkflow('app');
  assert.deepEqual(w.stages.implement.use, [{ ref: 'mattpocock-skills:tdd', kind: 'skill' }]);
  assert.deepEqual(w.stages.verify.use, [{ ref: 'factory-verifier', kind: 'agent' }, { ref: 'mattpocock-skills:code-review', kind: 'skill' }]);
  dismissProposals('global', [proposals[0].id]);
  assert.deepEqual(proposeGlobal().proposals.map((p) => p.stage), ['draft']);
});

test('a skill with a recommended name from another author is not mistaken for it', () => {
  write(path.join(tmp, 'claude', 'skills', 'research', 'SKILL.md'), skill('research', 'Someone else.'));
  assert.equal(proposeGlobal().recommended.items.find((i) => i.skill === 'research').installed, false);
});

const { unblock, blockKind } = await import('../lib/stages.mjs');
const { boardData } = await import('../lib/board.mjs');
const { linkSession, lastActivity } = await import('../lib/tokens.mjs');

test('an unclear issue blocks the task, and the board says it waits for the user with the questions', () => {
  at('triage', undefined);
  write(path.join(DIR, 'triage.md'), 'Type: bug\nScope: the add function\nVerdict: unclear\n');
  write(path.join(DIR, 'questions.md'), 'Which rounding do you want?\n');
  const r = step();
  assert.equal(r.moved, false);
  assert.equal(blockKind(loadState(ID)), 'unclear');
  const task = boardData().issues.find((i) => i.id === ID);
  assert.deepEqual([task.blockedKind, task.actor, task.docs.questions], ['unclear', 'Agent', 'Which rounding do you want?\n']);
  assert.match(task.questionsSha, /^[0-9a-f]{64}$/);
  assert.equal(blockKind({ blocked: { reason: '3 failed check runs at "gates"; the limit is 3.' } }), 'attempts');
  assert.equal(blockKind({ blocked: { reason: 'Waiting for design.' } }), 'other');
});

test('answering unblocks the task, and the agent must judge again before it can block a second time', () => {
  unblock(loadState(ID), { note: 'Round half up.' });
  const state = loadState(ID);
  assert.equal(state.blocked, null);
  assert.match(fs.readFileSync(path.join(DIR, 'answers.md'), 'utf8'), /^## \d{4}-.*\n\nRound half up\.\n$/);
  assert.match(state.history.at(-1).note, /^Unblocked with an answer: Round half up\./);
  const again = step();
  assert.equal(again.moved, false);
  assert.match(again.problems[0], /The user answered in .*answers\.md\. Read it, then update triage\.md/);
  assert.equal(loadState(ID).blocked, null);
  assert.match(formatBrief(stageBrief(loadState(ID), getRepo('app'))), /From the user:\n {2}- The user answered your questions or left a note in .*answers\.md\. Read it before anything else\./);
  write(path.join(DIR, 'triage.md'), 'Type: bug\nScope: the add function\nVerdict: clear\n');
  fs.utimesSync(path.join(DIR, 'triage.md'), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  assert.equal(step().moved, true);
});

test('continuing without an answer tells the agent to proceed on its best reading', () => {
  at('triage', undefined, { blocked: { reason: 'The issue is unclear. questions.md holds the draft for the user to review and post.', at: 'x' } });
  fs.rmSync(path.join(DIR, 'answers.md'), { force: true });
  unblock(loadState(ID));
  assert.match(fs.readFileSync(path.join(DIR, 'answers.md'), 'utf8'), /The user decided the issue is clear enough to proceed/);
  assert.equal(loadState(ID).history.at(-1).note, 'Unblocked.');
  assert.throws(() => unblock(loadState(ID)), /is not blocked/);
});

test('the brief repeats why a task was sent back', () => {
  at('ready', 'feature', { gatesSha: sh(APP, 'git rev-parse HEAD') });
  sendBack(loadState(ID), getRepo('app'), { reason: 'The option was removed.' });
  assert.match(formatBrief(stageBrief(loadState(ID), getRepo('app'))), /The user sent this task back at human review: The option was removed\. Fix that first\./);
  assert.equal(boardData().issues.find((i) => i.id === ID).sentBack, 'The option was removed.');
});

test('the board knows when a linked session last worked, and which column a task belongs to', () => {
  at('implement', 'feature');
  assert.equal(lastActivity(ID), null);
  const transcript = path.join(tmp, 'session.jsonl');
  write(transcript, '{}\n');
  fs.writeFileSync(path.join(DIR, 'sessions.json'), '[]');
  linkSession(ID, transcript);
  assert.ok(Date.now() - Date.parse(lastActivity(ID)) < 60_000);
  const phase = (stage, extra) => { at(stage, 'feature', extra); return boardData().issues.find((i) => i.id === ID).phase; };
  assert.deepEqual(['triage', 'plan', 'implement', 'gates', 'verify', 'ready', 'approved'].map((s) => phase(s)), ['start', 'start', 'build', 'check', 'check', 'review', 'ship']);
  assert.deepEqual(['checks', 'draft', 'ready'].map((s) => phase(s, { kind: 'review' })), ['check', 'build', 'review']);
});

test('a session that only names a task from elsewhere does not count as an agent working on it', () => {
  at('implement', 'feature');
  const encoded = APP.replace(/[^a-zA-Z0-9]/g, '-');
  const outside = path.join(tmp, 'projects', '-somewhere-else', 'a.jsonl');
  const inside = path.join(tmp, 'projects', encoded, 'b.jsonl');
  write(outside, '{}\n');
  fs.writeFileSync(path.join(DIR, 'sessions.json'), '[]');
  linkSession(ID, outside);
  assert.equal(lastActivity(ID, APP), null);
  assert.ok(lastActivity(ID));
  write(inside, '{}\n');
  linkSession(ID, inside);
  assert.ok(Date.now() - Date.parse(lastActivity(ID, APP)) < 60_000);
});

test('activity inside the worktree is told apart from a call that only names the task', async () => {
  const { recordActivity, activitySummary } = await import('../lib/activity.mjs');
  const state = at('implement', 'feature');
  fs.rmSync(path.join(DIR, 'activity.jsonl'), { force: true });
  recordActivity([state], { tool_name: 'Bash', tool_input: { command: `factory status ${ID}` }, cwd: tmp });
  assert.equal(activitySummary(state).lastInside, null);
  assert.equal(activitySummary(state).last.label, 'Bash');
  recordActivity([state], { tool_name: 'Edit', tool_input: { file_path: 'a.txt' }, cwd: APP });
  assert.equal(activitySummary(state).lastInside.label, 'Edit');
});

test('the board records a pull request the user opened by hand, only at the open-the-PR step', async () => {
  const server = await startServer(0, { pairing: false, followEvery: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = /__factoryToken="([0-9a-f]{32})"/.exec(await (await fetch(`${base}/`)).text())[1];
    const post = (headers, body) => fetch(`${base}/api/pr`, { method: 'POST', headers, body: JSON.stringify(body) });
    at('implement', 'feature');
    assert.equal((await post({}, { id: ID, url: 'https://github.com/acme/app/pull/9' })).status, 403);
    assert.match((await (await post({ 'x-factory-token': token }, { id: ID, url: 'https://github.com/acme/app/pull/9' })).json()).error, /is at "implement", not "approved"/);
    const head = sh(APP, 'git rev-parse HEAD');
    at('approved', 'feature', { gatesSha: head, approvedSha: head });
    assert.match((await (await post({ 'x-factory-token': token }, { id: ID, url: 'https://example.com/pull/9' })).json()).error, /Expected a PR URL like https:\/\/github\.com\/acme\/app\/pull\/123/);
    assert.equal((await post({ 'x-factory-token': token }, { id: ID, url: ' https://github.com/acme/app/pull/9 ' })).status, 200);
    assert.deepEqual([loadState(ID).stage, loadState(ID).prUrl], ['pr-opened', 'https://github.com/acme/app/pull/9']);
  } finally {
    server.close();
  }
});

test('the board pushes the approved branch and opens the pull request, and refuses a version that changed', async () => {
  const stub = path.join(tmp, 'gh-stub');
  write(path.join(stub, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${path.join(tmp, 'gh-args.txt')}"\necho "https://github.com/acme/app/pull/12"\n`);
  fs.chmodSync(path.join(stub, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${stub}${path.delimiter}${oldPath}`;
  const server = await startServer(0, { pairing: false, followEvery: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = /__factoryToken="([0-9a-f]{32})"/.exec(await (await fetch(`${base}/`)).text())[1];
    const create = (headers, body) => fetch(`${base}/api/pr/create`, { method: 'POST', headers, body: JSON.stringify(body) });
    const head = sh(APP, 'git rev-parse HEAD');
    write(path.join(DIR, 'pr-body.md'), 'Closes #5.\n');
    at('ready', 'feature', { gatesSha: head });
    assert.equal((await create({}, { id: ID })).status, 403);
    assert.match((await (await create({ 'x-factory-token': token }, { id: ID })).json()).error, /is at "ready"\. It can go out only right after you approve it/);
    at('approved', 'feature', { gatesSha: head, approvedSha: head, approvedDraftSha256: 'not-the-approved-text' });
    assert.match((await (await create({ 'x-factory-token': token }, { id: ID })).json()).error, /changed after you approved it/);
    assert.equal(sh(tmp, `git --git-dir "${path.join(tmp, 'app.git')}" branch --list task`), '');
    at('approved', 'feature', { gatesSha: head, approvedSha: head, approvedDraftSha256: fileSha256(path.join(DIR, 'pr-body.md')) });
    assert.match((await (await create({ 'x-factory-token': token }, { id: ID, reviewers: ['a; rm -rf /'] })).json()).error, /"a; rm -rf \/" is not a GitHub login/);
    assert.equal(sh(tmp, `git --git-dir "${path.join(tmp, 'app.git')}" branch --list task`), '');
    const made = await create({ 'x-factory-token': token }, { id: ID, title: 'fix(app): a title', draft: true, reviewers: ['@octocat', 'acme/frontend'], assignees: ['@me'] });
    assert.equal(made.status, 200, await made.clone().text());
    assert.equal((await made.json()).url, 'https://github.com/acme/app/pull/12');
    assert.match(sh(tmp, `git --git-dir "${path.join(tmp, 'app.git')}" rev-parse task`), new RegExp(head));
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'gh-args.txt'), 'utf8').trim().split('\n'), ['pr', 'create', '--repo', 'acme/app', '--base', 'main', '--head', 'task', '--title', 'fix(app): a title', '--body-file', path.join(DIR, 'pr-body.md'), '--reviewer', 'octocat', '--reviewer', 'acme/frontend', '--assignee', '@me', '--draft']);
    assert.deepEqual([loadState(ID).stage, loadState(ID).prUrl], ['pr-opened', 'https://github.com/acme/app/pull/12']);
  } finally {
    process.env.PATH = oldPath;
    server.close();
  }
});
