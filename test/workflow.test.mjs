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
  saveState({ id: ID, kind: 'issue', repo: 'app', issue: 5, title: 'Task', type, stage, stageSince: new Date().toISOString(), worktree: APP, branch: 'task', base: 'main', history: [], ...extra });
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

test('without a saved workflow the defaults hold: four types, four plan sections, reproduce only for bugs', () => {
  const w = resolveWorkflow('app');
  assert.deepEqual(w, defaultWorkflow());
  assert.deepEqual(w.types, ['bug', 'feature', 'docs', 'chore']);
  assert.deepEqual(w.stages.plan.headings, ['Files', 'Tests', 'Consumer impact', 'Changelog']);
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
  assert.deepEqual(defaultWorkflow().stages.plan.headings.length, 4);
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
  assert.deepEqual(problems, ['No verifier verdict at HEAD. The factory-verifier agent records it.']);
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
});

test('proposes the PR template headings, the instruction file and the scripts it names', () => {
  const { proposals } = proposeForProject('app');
  assert.deepEqual(proposals.find((p) => p.action === 'prBody').sections, ['Description', 'How to test', 'Checklist']);
  assert.deepEqual(proposals.find((p) => p.action === 'readFirst').files, ['AGENTS.md']);
  assert.deepEqual(proposals.filter((p) => p.action === 'gate').map((p) => p.gate), [{ name: 'lint', cmd: 'npm run lint' }, { name: 'test', cmd: 'npm test' }]);
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
  write(path.join(DIR, 'plan.md'), '## Files\n\n## Tests\n\n## Consumer impact\n\n## Changelog\n');
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

test('the ready stage is shown as "human review" and keeps its fixed rule', () => {
  const shape = workflowShape(resolveWorkflow('app'));
  const ready = shape.stages.find((s) => s.stage === 'ready');
  assert.deepEqual([ready.title, ready.actor, ready.removable, ready.configurable], ['human review', 'You', false, false]);
  assert.equal(shape.review.find((s) => s.stage === 'ready').title, 'human review');
  assert.match(formatBrief(stageBrief(at('ready', 'feature'), getRepo('app'))), /stage ready \(human review\)/);
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
  const { skills } = userAssets();
  assert.deepEqual(skills.find((s) => s.name === 'mine'), { name: 'mine', description: 'My own skill.' });
  assert.deepEqual(skills.find((s) => s.name === 'design:ux-copy'), { name: 'design:ux-copy', description: 'Writes UX copy.' });
});
