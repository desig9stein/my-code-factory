// Drives one bug through every stage in a throwaway workspace.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/codeignite.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-')));
const WORKSPACE = path.join(tmp, 'ws');
const ROOT = path.join(WORKSPACE, 'factory');
const REPO = path.join(WORKSPACE, 'demo');
const ID = 'demo-7';
const WT = path.join(ROOT, 'worktrees', ID);
const ISSUE = path.join(ROOT, 'issues', ID);

// A board port exported in the developer's shell must not change what the tests expect.
delete process.env.CODEIGNITE_PORT;
// Lets nested "node --test" runs report their own exit code.
delete process.env.NODE_TEST_CONTEXT;
Object.assign(process.env, {
  CODEIGNITE_ROOT: ROOT,
  CODEIGNITE_WORKSPACE: WORKSPACE,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

const { decide } = await import('../lib/guard.mjs');
const { approve, recordPr } = await import('../lib/stages.mjs');
const { loadState } = await import('../lib/state.mjs');
const { getRepo } = await import('../lib/registry.mjs');
const { boardData } = await import('../lib/board.mjs');
const { verifyChain } = await import('../lib/evidence.mjs');

function sh(cwd, cmd) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  return r.stdout.trim();
}
function cli(...args) {
  const r = spawnSync('node', [BIN, ...args], { encoding: 'utf8', cwd: WORKSPACE });
  return { status: r.status, out: r.stdout + r.stderr };
}
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const commit = (msg) => sh(WT, `git add -A && git commit -q -m "${msg}"`);
const bash = (command, cwd = WORKSPACE) => decide({ tool_name: 'Bash', tool_input: { command }, cwd });
const runGates = (...extra) => ['lint', 'test'].map((g) => cli('run', ID, g, ...extra));
const verdict = (v = 'pass', criteria = '## Acceptance criteria\n- add(2, 2) returns 4: checked, exit 0.\n\n') => {
  const report = path.join(tmp, 'report.md');
  write(report, `${criteria}Claim: add returns the sum. Checked with node --test test/add.test.mjs, exit 0.\n${'Detail of the check. '.repeat(12)}`);
  return cli('verdict', ID, v, '--report', report);
};
const PR_BODY = 'Closes #7.\n\n## Summary\n\n`add` returns the sum.\n\n## Type of change\n\n- [x] Bug fix\n';

before(() => {
  write(
    path.join(ROOT, 'repos.json'),
    JSON.stringify({
      defaults: { forbidAiAttribution: true, install: '', branchPattern: 'me/{type}-{n}-{slug}', maxCommits: 3, testable: true },
      repos: {
        demo: {
          remote: 'acme/demo',
          baseBranch: 'main',
          gates: [
            { name: 'lint', cmd: 'npm run lint' },
            { name: 'test', cmd: 'npm test' },
          ],
          prBody: { requiredSections: ['Summary'], tickedSection: 'Type of change' },
        },
        broken: { dir: 'demo', remote: 'acme/demo', baseBranch: 'main', gates: [{ name: 'nope', cmd: 'npm run nope' }] },
      },
    }),
  );
  write(path.join(WORKSPACE, 'WORK_LOG.md'), '# Work log\n\n## 2020-01-01\n- old line\n');
  const remote = path.join(tmp, 'acme/demo.git');
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  sh(tmp, `git init -q --bare -b main ${remote}`);
  fs.mkdirSync(REPO, { recursive: true });
  sh(REPO, 'git init -q -b main');
  write(path.join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { lint: 'node -e ""', test: 'node --test' } }));
  write(path.join(REPO, 'lib/add.mjs'), 'export const add = (a, b) => a - b;\n');
  write(path.join(REPO, 'test/smoke.test.mjs'), "import { test } from 'node:test';\ntest('loads', () => {});\n");
  sh(REPO, `git add -A && git commit -q -m "chore(repo): seed" && git remote add origin ${remote} && git push -q -u origin main && git remote set-head origin main`);
});

test('new creates the branch off the base with no upstream', () => {
  const r = cli('new', 'demo#7', '--title', 'Add returns the difference');
  assert.equal(r.status, 0, r.out);
  assert.equal(sh(WT, 'git rev-parse --abbrev-ref HEAD'), 'me/fix-7-add-returns-the-difference');
  assert.equal(spawnSync('git', ['rev-parse', '--abbrev-ref', '@{u}'], { cwd: WT }).status !== 0, true);
  assert.equal(loadState(ID).stage, 'intake');
});

test('a push on the Codeignite branch is refused before approval', () => {
  assert.equal(bash('git push -u origin HEAD', WT).deny, true);
  assert.equal(bash(`cd ${WT} && git push`).deny, true);
  assert.equal(bash('gh pr create --head me/fix-7-add-returns-the-difference').deny, true);
  assert.equal(bash('gh issue comment 7 -R acme/demo --body hi').deny, true);
});

test('a push on a branch Codeignite does not own is allowed', () => {
  assert.equal(bash('git push origin main', REPO).deny, false);
  assert.equal(bash('gh issue comment 8 -R acme/demo --body hi').deny, false);
});

test('an agent cannot approve or write state and evidence', () => {
  assert.equal(bash(`node factory/bin/codeignite.mjs approve ${ID}`).deny, true);
  assert.equal(bash(`echo '{}' > factory/issues/${ID}/state.json`).deny, true);
  assert.equal(bash(`cat factory/issues/${ID}/state.json 2>/dev/null`).deny, false);
  // The same actions written another way: a quoted word, a file named from inside its folder, the GitHub API.
  assert.equal(bash(`node factory/bin/codeignite.mjs "approve" ${ID}`).deny, true);
  assert.equal(bash(`cd factory/issues/${ID} && echo '{}' > state.json`).deny, true);
  assert.equal(bash(`cd factory/issues/${ID} && rm -rf evidence`).deny, true);
  assert.equal(bash(`cd factory/issues/${ID} && cat state.json && echo done > notes.md`).deny, true);
  assert.equal(bash(`cd factory/issues/${ID} && ls`).deny, false);
  assert.equal(bash(`cd factory/issues/${ID} && echo "Type: bug" > triage.md`).deny, false);
  assert.equal(bash('gh api repos/acme/demo/issues/7/comments -f body=hi', WT).deny, true);
  assert.equal(bash('gh api repos/acme/demo/pulls -f head=x -f base=main', WT).deny, true);
  assert.equal(bash('gh api -X POST repos/acme/demo/issues/7/comments --input body.json', WT).deny, true);
  assert.equal(bash('gh api repos/acme/demo/pulls/7/files', WT).deny, false);
  assert.equal(bash('gh api repos/acme/demo/pulls', WT).deny, false);
  const edit = (file) => decide({ tool_name: 'Edit', tool_input: { file_path: file }, cwd: WORKSPACE });
  assert.equal(edit(path.join(ISSUE, 'state.json')).deny, true);
  assert.equal(edit(path.join(ISSUE, 'evidence/001-lint.json')).deny, true);
  assert.equal(edit(path.join(ISSUE, 'verify.md')).deny, true);
  assert.equal(edit(path.join(ISSUE, 'plan.md')).deny, false);
});

test('an MCP push naming the Codeignite branch is refused', () => {
  const d = decide({ tool_name: 'mcp__GitKraken__git_push', tool_input: { branch: 'me/fix-7-add-returns-the-difference' }, cwd: WORKSPACE });
  assert.equal(d.deny, true);
});

test('approve refuses to run without a terminal', () => {
  const r = cli('approve', ID);
  assert.equal(r.status, 1);
  assert.match(r.out, /interactive terminal/);
});

test('triage needs type, scope and verdict', () => {
  assert.equal(cli('advance', ID).status, 0);
  write(path.join(ISSUE, 'triage.md'), 'Type: bug\n');
  const r = cli('advance', ID);
  assert.equal(r.status, 1);
  assert.match(r.out, /Scope:/);
  assert.match(r.out, /Verdict:/);
});

test('an unclear verdict blocks the issue until it is unblocked', () => {
  write(path.join(ISSUE, 'triage.md'), 'Type: bug\nScope: lib/add.mjs only\nVerdict: unclear\n');
  assert.match(cli('advance', ID).out, /questions\.md/);
  write(path.join(ISSUE, 'questions.md'), 'Which sign is expected?\n');
  cli('advance', ID);
  assert.ok(loadState(ID).blocked);
  assert.match(cli('advance', ID).out, /Blocked/);
  write(path.join(ISSUE, 'triage.md'), 'Type: bug\nScope: lib/add.mjs only\nVerdict: clear\n');
  cli('unblock', ID);
  assert.equal(cli('advance', ID).status, 0);
  assert.equal(loadState(ID).stage, 'reproduce');
});

test('a reproduction recorded without --expect-fail does not count', () => {
  assert.equal(cli('run', ID, 'reproduce', '--', 'true').status, 0);
  const r = cli('advance', ID);
  assert.equal(r.status, 1);
  assert.match(r.out, /without --expect-fail/);
  assert.equal(loadState(ID).stage, 'reproduce');
});

test('a recorded command cannot leave the worktree', () => {
  const r = cli('run', ID, 'extra:escape', '--cwd', '../..', '--', 'pwd');
  assert.equal(r.status, 1);
  assert.match(r.out, /leaves the worktree/);
  assert.match(cli('regress', ID, '--tests', 'test/smoke.test.mjs', '--cwd', '..', '--', 'true').out, /leaves the worktree/);
});

test('arguments after "--" keep their quoting', () => {
  const r = cli('run', ID, 'extra:quoting', '--', 'node', '-e', 'console.log(6 * 7)');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^42$/m);
});

test('a title with no Latin letters still yields a usable branch', () => {
  const r = cli('new', 'demo#9', '--title', 'Първа задача');
  assert.equal(r.status, 0, r.out);
  assert.equal(loadState('demo-9').branch, 'me/fix-9-issue');
  assert.equal(cli('archive', 'demo-9', '--delete-branch').status, 0);
});

test('a command that outlives its time limit is recorded as failed, not left hanging', async () => {
  const { runRecorded } = await import('../lib/evidence.mjs');
  const record = runRecorded(loadState(ID), { name: 'extra:slow', kind: 'run', cmd: 'exec sleep 20', cwd: WT, expect: 'fail', timeoutMinutes: 0.002 });
  assert.equal(record.timedOut, true);
  assert.equal(record.ok, false);
  assert.match(fs.readFileSync(path.join(ISSUE, 'evidence', record.log), 'utf8'), /Stopped after/);
});

test('a reproduction that exits 0 does not count', () => {
  cli('run', ID, 'reproduce', '--expect-fail', '--', 'true');
  assert.match(cli('advance', ID).out, /did not show the bug/);
  const r = cli('run', ID, 'reproduce', '--expect-fail', '--', `node -e "import('./lib/add.mjs').then(m=>process.exit(m.add(2,2)===4?0:1))"`);
  assert.equal(r.status, 0, r.out);
  assert.equal(cli('advance', ID).status, 0);
});

test('plan needs its sections and at least one acceptance criterion', () => {
  write(path.join(ISSUE, 'plan.md'), '## Files\nlib/add.mjs\n');
  const missing = cli('advance', ID).out;
  assert.match(missing, /## Consumer impact/);
  assert.match(missing, /## Acceptance criteria/);
  const rest = '## Files\nlib/add.mjs\n## Test boundaries\nadd()\n## Tests\nadd.test\n## Consumer impact\nNone.\n## Changelog\nNone.\n';
  write(path.join(ISSUE, 'plan.md'), `## Acceptance criteria\nIt works.\n${rest}`);
  assert.match(cli('advance', ID).out, /at least one list item/);
  write(path.join(ISSUE, 'plan.md'), `## Acceptance criteria\n- add(2, 2) returns 4.\n${rest}`);
  assert.equal(cli('advance', ID).status, 0);
  assert.deepEqual(boardData().issues[0].criteria, ['add(2, 2) returns 4.']);
});

test('a trivial task skips reproduce and plan, and is sent back when it outgrows the tier', () => {
  const id = 'demo-11';
  const wt = path.join(ROOT, 'worktrees', id);
  assert.equal(cli('new', 'demo#11', '--title', 'Fix a typo').status, 0);
  assert.equal(cli('advance', id).status, 0);
  const triage = path.join(ROOT, 'issues', id, 'triage.md');
  write(triage, 'Type: docs\nScope: one comment.\nVerdict: clear\nTier: tiny\n');
  assert.match(cli('advance', id).out, /"Tier:" must be one of trivial, standard/);
  write(triage, 'Type: docs\nScope: one comment.\nVerdict: clear\nTier: trivial\n');
  assert.equal(cli('advance', id).status, 0);
  assert.equal(loadState(id).stage, 'implement');
  for (const f of ['a.md', 'b.md', 'c.md']) write(path.join(wt, f), 'x\n');
  sh(wt, 'git add -A && git commit -q -m "docs(readme): fix typos"');
  const big = cli('advance', id);
  assert.equal(big.status, 1);
  assert.match(big.out, /at most 2 changed files; this branch changes 3/);
  write(triage, 'Type: docs\nScope: three files.\nVerdict: clear\nTier: standard\n');
  assert.equal(cli('advance', id).status, 0);
  const s = loadState(id);
  // A docs task has no reproduction, so the raised tier lands on the plan.
  assert.deepEqual([s.stage, s.tier], ['plan', 'standard']);
  assert.equal(cli('archive', id, '--delete-branch').status, 0);
});

test('implement needs a commit and a clean tree', () => {
  assert.match(cli('advance', ID).out, /No commits/);
  write(path.join(WT, 'lib/add.mjs'), 'export const add = (a, b) => a + b;\n');
  write(path.join(WT, 'test/add.test.mjs'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../lib/add.mjs';\ntest('adds', () => assert.equal(add(2, 2), 4));\n");
  assert.match(cli('advance', ID).out, /uncommitted/);
  commit('fix(add): return the sum');
  assert.equal(cli('advance', ID).status, 0);
});

test('the board says what the stage needs, and how large the change is, without moving the task', () => {
  const before = fs.readFileSync(path.join(ISSUE, 'state.json'), 'utf8');
  const data = boardData();
  const issue = data.issues.find((i) => i.id === ID);
  assert.equal(issue.needs.canAdvance, false);
  assert.match(issue.needs.problems.join('\n'), /Gate "lint" is not-run/);
  assert.match(issue.needs.problems.join('\n'), /Regression proof is missing/);
  assert.deepEqual(issue.changes, { files: 2, additions: 5, deletions: 1 });
  assert.equal(data.metrics.tasks.some((t) => t.id === ID), true);
  // Two registry entries share the demo repository; neither declares a relationship, so nothing is reached.
  assert.deepEqual(data.graph.nodes.map((n) => [n.key, n.layer, n.reach.length]), [['demo', 0, 0], ['broken', 0, 0]]);
  assert.deepEqual(issue.reach, []);
  assert.equal(fs.readFileSync(path.join(ISSUE, 'state.json'), 'utf8'), before);
});

test('the pre-tool hook records an allowed call for the task and skips a refused one', () => {
  const hook = (payload) => spawnSync('node', [path.join(path.dirname(BIN), 'guard.mjs'), 'pre'], { input: JSON.stringify(payload), encoding: 'utf8' });
  const log = path.join(ISSUE, 'activity.jsonl');
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const before = lines().length;
  assert.equal(hook({ cwd: WT, tool_name: 'Bash', tool_use_id: 'toolu_a', tool_input: { command: 'npm test -- --secret-flag' } }).stdout, '');
  assert.match(hook({ cwd: WT, tool_name: 'Bash', tool_input: { command: 'git push -u origin HEAD' } }).stdout, /"deny"/);
  assert.equal(hook({ cwd: WORKSPACE, tool_name: 'Read', tool_input: { file_path: '/elsewhere/file' } }).status, 0);
  // A guard that cannot read the registry does not wave an outward action through, whichever tool asks.
  const registryFile = path.join(ROOT, 'repos.json'), registryText = fs.readFileSync(registryFile, 'utf8');
  fs.writeFileSync(registryFile, '{broken');
  try {
    assert.match(hook({ cwd: WT, tool_name: 'mcp__github__create_pull_request', tool_input: { head: 'x' } }).stdout, /"ask".*could not check/);
    assert.match(hook({ cwd: WT, tool_name: 'Bash', tool_input: { command: 'git push' } }).stdout, /"ask"/);
    assert.equal(hook({ cwd: WORKSPACE, tool_name: 'mcp__github__get_file_contents', tool_input: { path: 'a' } }).stdout, '');
  } finally {
    fs.writeFileSync(registryFile, registryText);
  }
  const added = lines().slice(before);
  assert.deepEqual(added.map((l) => [l.stage, l.kind, l.label, l.detail, l.use]), [['gates', 'tool', 'Bash', 'npm', 'toolu_a']]);
  const activity = boardData().issues.find((i) => i.id === ID).activity;
  assert.equal(activity.recorded, true);
  assert.equal(activity.byStage.find((s) => s.stage === 'gates').items[0].label, 'Bash');
});

test('a gate runs only the registry command', () => {
  const r = cli('run', ID, 'test', '--', 'true');
  assert.equal(r.status, 1);
  assert.match(r.out, /always runs the registry command/);
});

test('gates need every gate and the regression proof at HEAD', () => {
  const r = cli('advance', ID);
  assert.match(r.out, /Gate "lint" is not-run/);
  assert.match(r.out, /Regression proof is missing/);
  for (const g of runGates()) assert.equal(g.status, 0, g.out);
  assert.match(cli('advance', ID).out, /Regression proof is missing/);
});

test('regress rejects a test that passes on the base', () => {
  const r = cli('regress', ID, '--tests', 'test/add.test.mjs', '--', 'node --test test/smoke.test.mjs');
  assert.equal(r.status, 1);
  assert.match(r.out, /does not cover the fix/);
  const wrongReason = cli('regress', ID, '--tests', 'test/add.test.mjs', '--expect-output', 'text the failure never prints', '--', 'node --test test/add.test.mjs');
  assert.equal(wrongReason.status, 1);
  assert.match(wrongReason.out, /output lacks/);
  assert.match(cli('advance', ID).out, /Regression proof is failed/);
});

test('regress passes when the test fails on the base and passes on the fix', () => {
  const r = cli('regress', ID, '--tests', 'test/add.test.mjs', '--expect-output', 'strictly equal', '--', 'node --test test/add.test.mjs');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Why the base fails/);
  assert.equal(fs.existsSync(path.join(ROOT, 'worktrees', `.regress-${ID}`)), false);
  assert.equal(cli('advance', ID).status, 0);
  assert.equal(loadState(ID).stage, 'verify');
});

test('verify needs the verifier runs, the PR body and the verdict', () => {
  const r = cli('advance', ID);
  assert.match(r.out, /verifier has no passing run of "lint"/);
  assert.match(r.out, /pr-body\.md is missing/);
  assert.match(r.out, /No verifier verdict/);
});

test('the PR body must carry the sections the repo CI checks', () => {
  write(path.join(ISSUE, 'pr-body.md'), 'Closes #7.\n\n## Summary\n\nFix.\n\n## Type of change\n\n- [ ] Bug fix\n');
  assert.match(cli('check', ID).out, /Tick at least one box/);
  write(path.join(ISSUE, 'pr-body.md'), '## Type of change\n\n- [x] Bug fix\n');
  const r = cli('check', ID);
  assert.match(r.out, /never references #7/);
  assert.match(r.out, /"## Summary" is missing/);
  write(path.join(ISSUE, 'pr-body.md'), PR_BODY);
  assert.equal(cli('check', ID).status, 0);
});

test('a passing verdict must answer the acceptance criteria of the plan', () => {
  const r = verdict('pass', '');
  assert.equal(r.status, 1);
  assert.match(r.out, /lists 1 acceptance criteria/);
});

test('a verdict recorded on a dirty tree does not count', () => {
  for (const g of runGates('--as', 'verifier')) assert.equal(g.status, 0, g.out);
  write(path.join(WT, 'stray.txt'), 'x');
  assert.equal(verdict().status, 0);
  fs.rmSync(path.join(WT, 'stray.txt'));
  const r = cli('advance', ID);
  assert.equal(r.status, 1);
  assert.match(r.out, /uncommitted changes, so it does not describe the commit/);
});

test('a PR body edited after the verdict needs a new verdict', () => {
  for (const g of runGates('--as', 'verifier')) assert.equal(g.status, 0, g.out);
  assert.equal(verdict().status, 0);
  write(path.join(ISSUE, 'pr-body.md'), `${PR_BODY}\nExtra claim.\n`);
  assert.match(cli('advance', ID).out, /changed after the verdict/);
  assert.equal(verdict().status, 0);
  assert.equal(cli('advance', ID).status, 0);
  assert.equal(loadState(ID).stage, 'ready');
  assert.match(fs.readFileSync(path.join(WORKSPACE, 'WORK_LOG.md'), 'utf8'), /## \d{4}-\d\d-\d\d\n- `demo` — \[#7\].*ready for review, not pushed\.\n\n## 2020-01-01/);
});

test('ready still refuses the push until approval', () => {
  assert.equal(bash('git push -u origin HEAD', WT).deny, true);
  // What let the task reach "ready" is looked at again when it is approved.
  const body = path.join(ISSUE, 'pr-body.md');
  const judged = fs.readFileSync(body, 'utf8');
  write(body, `${judged}\nA claim the verifier never saw.\n`);
  assert.throws(() => approve(loadState(ID)), /cannot be approved as it stands:\n- pr-body\.md changed after the verdict/);
  write(body, judged);
  write(path.join(WT, 'stray.txt'), 'x');
  assert.throws(() => approve(loadState(ID)), /The worktree has uncommitted changes/);
  fs.rmSync(path.join(WT, 'stray.txt'));
  assert.equal(cli('block', ID, 'a question is open').status, 0);
  assert.throws(() => approve(loadState(ID)), /It is blocked: a question is open/);
  assert.equal(cli('unblock', ID).status, 0);
  approve(loadState(ID));
  assert.equal(bash('git push -u origin HEAD', WT).deny, false);
});

test('a PR body edited after approval refuses the push until the approved text returns', () => {
  const body = path.join(ISSUE, 'pr-body.md');
  const approved = fs.readFileSync(body, 'utf8');
  write(body, `${approved}\nA claim nobody approved.\n`);
  const refused = bash('gh pr create --head me/fix-7-add-returns-the-difference --body-file pr-body.md');
  assert.equal(refused.deny, true);
  assert.match(refused.reason, /unchanged pr-body\.md/);
  assert.equal(bash('git push -u origin HEAD', WT).deny, true);
  write(body, approved);
  assert.equal(bash('git push -u origin HEAD', WT).deny, false);
});

test('a commit after approval drops the run to gates and refuses the push again', () => {
  write(path.join(WT, 'lib/extra.mjs'), 'export const x = 1;\n');
  commit('wip');
  assert.equal(bash('git push -u origin HEAD', WT).deny, true);
  const s = loadState(ID);
  assert.equal(s.stage, 'gates');
  assert.equal(s.approvedSha, null);
  const data = boardData().issues[0];
  assert.deepEqual(data.gates.map((g) => g.status), ['stale', 'stale']);
  assert.equal(data.regress, 'stale');
});

test('the commit check rejects a subject without a scope and AI attribution', () => {
  sh(WT, 'git commit -q --allow-empty -m "fixed stuff" -m "Co-Authored-By: Claude <noreply@anthropic.com>"');
  const r = cli('check', ID);
  assert.match(r.out, /"wip" is not Conventional Commits/);
  assert.match(r.out, /fix-up or WIP/);
  assert.match(r.out, /carries AI attribution/);
  sh(WT, 'git reset -q --soft HEAD~2 && git commit -q -m "refactor(add): export a constant"');
  assert.equal(cli('check', ID).status, 0);
});

test('a re-run cycle reaches pr-opened and logs the PR', () => {
  for (const g of runGates()) assert.equal(g.status, 0, g.out);
  assert.equal(cli('regress', ID, '--tests', 'test/add.test.mjs', '--', 'node --test test/add.test.mjs').status, 0);
  assert.equal(cli('advance', ID).status, 0);
  for (const g of runGates('--as', 'verifier')) assert.equal(g.status, 0, g.out);
  verdict();
  assert.equal(cli('advance', ID).status, 0);
  approve(loadState(ID));
  const repo = getRepo('demo');
  assert.throws(() => recordPr(loadState(ID), repo, 'https://example.com/pull/1'), /Expected a PR URL/);
  assert.equal(cli('pr', ID, 'https://github.com/acme/demo/pull/9').status, 0);
  assert.equal(loadState(ID).stage, 'pr-opened');
  assert.match(fs.readFileSync(path.join(WORKSPACE, 'WORK_LOG.md'), 'utf8'), /\[#9\]\(https:\/\/github\.com\/acme\/demo\/pull\/9\) for \[#7\].*opened, awaiting review/);
});

test('metrics derive first pass, resets and time to approval from the records', async () => {
  const { factoryMetrics } = await import('../lib/metrics.mjs');
  const { tasks, summary } = factoryMetrics();
  const t = tasks.find((x) => x.id === ID);
  assert.equal(t.firstPass, true);
  assert.equal(t.resets, 1);
  assert.equal(t.failedGateRuns, 0);
  assert.equal(typeof t.hoursToApproval, 'number');
  // No transcript is linked yet: usage is unknown, not zero.
  assert.equal(t.freshTokens, null);
  // Archived tasks that never ran a gate stay out of the rate.
  assert.equal(tasks.find((x) => x.id === 'demo-11').firstPass, null);
  assert.deepEqual([summary.withGateRuns, summary.firstPass, summary.firstPassRate], [1, 1, 1]);
  const out = cli('metrics').out;
  assert.match(out, /First-pass gate rate: 100% \(1 of 1 tasks with gate runs; 2 without runs are left out\)/);
  assert.match(out, /demo-11 .* n\/a/);
  assert.equal(JSON.parse(cli('metrics', '--json').out).summary.resets, 1);
});

test('an edited evidence record is reported and stops advance', () => {
  const file = path.join(ISSUE, 'evidence', '001-reproduce.json');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('"exitCode": 0', '"exitCode": 1'));
  assert.match(verifyChain(ID).join(' '), /Record 1 \(reproduce\) was edited/);
  assert.match(cli('advance', ID).out, /Evidence integrity/);
  assert.match(cli('status', ID).out, /EVIDENCE TAMPERED/);
  fs.writeFileSync(file, original);
  assert.deepEqual(verifyChain(ID), []);
});

test('doctor reports a gate whose script is missing', () => {
  const r = cli('doctor');
  assert.equal(r.status, 1);
  assert.match(r.out, /broken: gate "nope" runs script "nope"/);
  assert.doesNotMatch(r.out, /^- demo:/m);
});

test('board writes the page and a data file with every issue', () => {
  assert.equal(cli('board', '--static', '--no-open').status, 0);
  assert.ok(fs.existsSync(path.join(ROOT, 'board.html')));
  const page = fs.readFileSync(path.join(ROOT, 'board.html'), 'utf8');
  assert.match(page, /<svg[^>]*class="fd-logo"/);
  assert.match(page, /rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,%3Csvg/);
  assert.match(fs.readFileSync(path.join(ROOT, 'board-data.js'), 'utf8'), /^window\.__factoryData\(\{.*"id":"demo-7"/);
  // The post-tool hook rebuilds the file only for calls that concern a task.
  const data = path.join(ROOT, 'board-data.js');
  const hook = (command) => spawnSync('node', [path.join(path.dirname(BIN), 'guard.mjs'), 'post'], { input: JSON.stringify({ cwd: WORKSPACE, tool_input: { command } }), encoding: 'utf8' });
  fs.utimesSync(data, new Date(0), new Date(0));
  assert.equal(hook('ls -la').status, 0);
  assert.equal(fs.statSync(data).mtimeMs, 0);
  assert.equal(hook(`codeignite status ${ID}`).status, 0);
  assert.notEqual(fs.statSync(data).mtimeMs, 0);
  // A second task call right after does not rebuild it again: the rewrite is limited to twice a minute.
  const fresh = fs.statSync(data).mtimeMs;
  assert.equal(hook(`codeignite status ${ID}`).status, 0);
  assert.equal(fs.statSync(data).mtimeMs, fresh);
});

test('tokens count the calls that acted on the issue once each, plus its subagents', async () => {
  const { issueTokens, linkSession } = await import('../lib/tokens.mjs');
  const transcript = path.join(tmp, 'sess.jsonl');
  const row = (id, timestamp, output, command = `codeignite run ${ID} lint`) =>
    JSON.stringify({ type: 'assistant', timestamp, message: { id, content: [{ type: 'tool_use', input: { command } }], usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output } } });
  const later = new Date(Date.now() + 60_000).toISOString();
  write(transcript, [row('m0', '2000-01-01T00:00:00.000Z', 999), row('m1', later, 5), row('m1', later, 5), row('m2', later, 7), row('m3', later, 500, 'npm test in another repo'), '{"type":"user","usage":1}'].join('\n'));
  write(path.join(tmp, 'sess/subagents/agent-a.jsonl'), [JSON.stringify({ type: 'user', message: { content: `Verify Codeignite issue ${ID}.` } }), row('s1', later, 3, 'ls')].join('\n'));
  write(path.join(tmp, 'sess/subagents/agent-b.jsonl'), [JSON.stringify({ type: 'user', message: { content: 'Explore something else.' } }), row('s2', later, 800, 'ls')].join('\n'));
  assert.equal(issueTokens(loadState(ID), { force: true }).sessions, 0);
  linkSession(ID, transcript);
  linkSession(ID, transcript);
  const t = issueTokens(loadState(ID), { force: true });
  assert.deepEqual([t.sessions, t.messages, t.output, t.input, t.cacheWrite, t.cacheRead, t.fresh, t.total], [1, 3, 15, 30, 300, 3000, 345, 3345]);
});

test('the board server archives only with its token and its own host', async () => {
  const { startServer } = await import('../lib/server.mjs');
  const server = await startServer(0, { pairing: false });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const call = (pathname, init = {}) => fetch(`${base}${pathname}`, init);
    const otherHost = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.test' } }, (res) => resolve(res.statusCode));
    });
    assert.equal(otherHost, 403);
    assert.equal((await (await call('/api/ping')).json()).pid, process.pid);
    const page = await (await call('/')).text();
    const token = /__factoryToken="([0-9a-f]{32})"/.exec(page)?.[1];
    assert.ok(token);
    assert.match(await (await call('/board-data.js')).text(), /"id":"demo-7"/);
    // Another site including the data as a script is refused; the page's own requests are not.
    for (const site of ['cross-site', 'same-site']) {
      const foreign = await call('/board-data.js', { headers: { 'sec-fetch-site': site } });
      assert.equal(foreign.status, 403);
      assert.doesNotMatch(await foreign.text(), /demo-7/);
    }
    assert.equal((await call('/board-data.js', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
    // The event stream announces a change to task data, and is closed to other sites.
    assert.equal((await call('/api/events', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    const announced = await new Promise((resolve, reject) => {
      let request = null;
      const timer = setTimeout(() => { request?.destroy(); reject(new Error('no change event within 5 s')); }, 5000);
      request = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
        assert.match(res.headers['content-type'], /text\/event-stream/);
        res.setEncoding('utf8');
        let seen = '';
        res.on('data', (chunk) => {
          seen += chunk;
          if (seen.includes('retry:') && !seen.includes('event:')) fs.writeFileSync(path.join(ISSUE, 'notes.md'), `seen ${Date.now()}\n`);
          if (seen.includes('event: change')) { clearTimeout(timer); request.destroy(); resolve(true); }
        });
      });
      request.on('error', () => {});
    });
    assert.equal(announced, true);
    assert.equal((await call('/issues/../repos.json.log')).status, 404);
    const diff = await call(`/api/diff?id=${ID}`);
    assert.equal(diff.status, 200);
    assert.match((await diff.json()).diff, /diff --git/);
    assert.equal((await call('/api/diff?id=..%2Foutside')).status, 400);
    const outside = path.join(tmp, 'private.log');
    write(outside, 'must not be served');
    fs.symlinkSync(outside, path.join(ISSUE, 'evidence', 'escape.log'));
    assert.equal((await call(`/issues/${ID}/evidence/escape.log`)).status, 404);
    const post = (headers, body) => call('/api/archive', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post({}, { id: ID })).status, 403);
    write(path.join(WT, 'stray.txt'), 'x');
    const dirty = await post({ 'x-factory-token': token }, { id: ID });
    assert.equal(dirty.status, 400);
    assert.match((await dirty.json()).error, /uncommitted changes/);
    fs.rmSync(path.join(WT, 'stray.txt'));
    assert.equal((await post({ 'x-factory-token': token }, { id: ID, deleteBranch: true })).status, 200);
    assert.equal(fs.existsSync(WT), false);
    assert.equal(sh(REPO, 'git branch --list "me/*"'), '');
    assert.equal(loadState(ID).archived, true);
    assert.equal(boardData().issues.length, 0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('one damaged task or a removed project is reported and does not hide the other tasks', async () => {
  const { describeCall, readActivity } = await import('../lib/activity.mjs');
  assert.equal(cli('new', 'demo#30', '--title', 'Healthy task').status, 0);
  assert.equal(cli('new', 'demo#31', '--title', 'Task to damage').status, 0);
  const file = path.join(ROOT, 'issues', 'demo-31', 'state.json');
  const good = fs.readFileSync(file, 'utf8');
  write(file, '{broken');
  let data = boardData();
  assert.deepEqual(data.issues.map((i) => i.id), ['demo-30']);
  assert.match(data.skipped.find((s) => s.id === 'demo-31').reason, /cannot be read/);
  const listed = cli('status');
  assert.equal(listed.status, 0);
  assert.match(listed.out, /! demo-31: The state of demo-31 cannot be read/);
  assert.match(listed.out, /demo-30/);
  // The task's project disappears from the registry.
  write(file, good.replace('"repo": "demo"', '"repo": "gone"'));
  data = boardData();
  assert.deepEqual(data.issues.map((i) => i.id), ['demo-30']);
  assert.match(data.skipped.find((s) => s.id === 'demo-31').reason, /Unknown repo "gone"/);
  assert.match(cli('status').out, /project "gone" is not in the registry/);
  write(file, good);
  // Unreadable activity lines are ignored; hostile tool names are reduced to plain words.
  write(path.join(ROOT, 'issues', 'demo-30', 'activity.jsonl'), 'garbage\n{"at":"not a date","stage":"intake","kind":"tool","label":"x"}\n{"kind":5}\n');
  assert.deepEqual(readActivity('demo-30'), []);
  assert.equal(boardData().issues.find((i) => i.id === 'demo-30').activity.recorded, false);
  assert.equal(describeCall({ tool_name: '<img src=x onerror=alert(1)>', tool_input: {} }).label, 'img srcx onerroralert1');
  assert.equal(describeCall({ tool_name: 'Skill', tool_input: { skill: { nested: true } } }).label, 'skill');
  assert.equal(describeCall({ tool_name: 'Bash', tool_input: { command: ['not', 'a', 'string'] } }).detail, '');
  // A damaged registry is named as the problem.
  const registry = path.join(ROOT, 'repos.json');
  const kept = fs.readFileSync(registry, 'utf8');
  write(registry, '{');
  assert.match(cli('graph').out, /repos\.json is not valid JSON/);
  write(registry, kept);
  for (const id of ['demo-30', 'demo-31']) assert.equal(cli('archive', id, '--delete-branch').status, 0);
});

test('evidence that is removed, forged or unreadable is found, and one bad file does not stop the task list', async () => {
  const crypto = await import('node:crypto');
  assert.equal(cli('new', 'demo#40', '--title', 'Sealed task').status, 0);
  const dir = path.join(ROOT, 'issues', 'demo-40', 'evidence');
  assert.equal(loadState('demo-40').sealed, true);
  assert.deepEqual(verifyChain('demo-40'), []);
  cli('run', 'demo-40', 'lint');
  cli('run', 'demo-40', 'lint');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
  assert.equal(files.length, 2);
  const last = path.join(dir, files[1]);
  const kept = fs.readFileSync(last, 'utf8');
  // The newest record removed: the links between the others still hold, the count does not.
  fs.rmSync(last);
  assert.match(verifyChain('demo-40').join(' '), /2 evidence record\(s\) were written and 1 is there: the newest were removed/);
  // A record rewritten with its hash worked out again.
  const forged = { ...JSON.parse(kept), durationMs: 1 };
  delete forged.hash;
  forged.hash = crypto.createHash('sha256').update(JSON.stringify(forged)).digest('hex');
  write(last, JSON.stringify(forged));
  assert.match(verifyChain('demo-40').join(' '), /The newest evidence record is not the one that was written last/);
  // The sealed count itself removed.
  write(last, kept);
  const head = path.join(dir, '.head');
  const seal = fs.readFileSync(head, 'utf8');
  fs.rmSync(head);
  assert.match(verifyChain('demo-40').join(' '), /The sealed count of the evidence is missing or was edited/);
  write(head, seal.replace('"count":2', '"count":1'));
  assert.match(verifyChain('demo-40').join(' '), /The sealed count of the evidence is missing or was edited/);
  write(head, seal);
  assert.deepEqual(verifyChain('demo-40'), []);
  // A file that cannot be read is tampering on its task, and every other command still works.
  write(last, '{"seq":');
  assert.match(verifyChain('demo-40').join(' '), /Record file 002-lint\.json cannot be read/);
  const listed = cli('status');
  assert.equal(listed.status, 0, listed.out);
  assert.match(listed.out, /demo-40/);
  assert.match(cli('advance', 'demo-40').out, /Evidence integrity: Record file 002-lint\.json cannot be read/);
  write(last, kept);
  assert.deepEqual(verifyChain('demo-40'), []);
});

test('a copied task folder, an impossible issue number and an archived task are each refused in plain words', () => {
  // A copy still says the first task's id; a command on it would change the first task.
  fs.cpSync(path.join(ROOT, 'issues', 'demo-40'), path.join(ROOT, 'issues', 'demo-40.bak'), { recursive: true });
  const blocked = cli('block', 'demo-40.bak', 'x');
  assert.equal(blocked.status, 1);
  assert.match(blocked.out, /The state of demo-40\.bak cannot be used: it says it is task "demo-40", which is not the name of its folder/);
  assert.equal(loadState('demo-40').blocked, null);
  assert.match(cli('status').out, /! demo-40\.bak: The state of demo-40\.bak cannot be used/);
  fs.rmSync(path.join(ROOT, 'issues', 'demo-40.bak'), { recursive: true });
  for (const state of ['null', '[]', '{}', '5', '{"id":"demo-40","stage":"intake","repo":"demo"}']) {
    const file = path.join(ROOT, 'issues', 'demo-40', 'state.json');
    const good = fs.readFileSync(file, 'utf8');
    write(file, state);
    assert.match(cli('next', 'demo-40').out, /The state of demo-40 cannot be used: it /, state);
    write(file, good);
  }
  // Nothing is created for a number that cannot be an issue.
  for (const ref of ['demo#0', 'demo#99999999999999999999999', 'demo#9007199254740993']) {
    const made = cli('new', ref, '--title', 'x');
    assert.equal(made.status, 1, ref);
    assert.match(made.out, /is not an issue number/);
  }
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'worktrees')).filter((name) => /e\+|^demo-0$|9007/.test(name)), []);
  assert.match(cli('new', 'demo#41', '--title').out, /--title needs a value/);
  assert.equal(fs.existsSync(path.join(ROOT, 'worktrees', 'demo-41')), false);
  // Commands given too little say what they need.
  assert.match(cli('run', 'demo-40').out, /run needs the name of what to run/);
  assert.match(cli('verdict', 'demo-40', 'pass', '--report', tmp).out, /verdict needs --report <file>/);
  assert.match(cli('review', 'demo#77', '--from', path.join(tmp, 'no-such.json')).out, /cannot be read as a pull request \(there is no such file\)/);
  // An archived task says so, and is not archived twice.
  assert.equal(cli('archive', 'demo-40', '--delete-branch').status, 0);
  assert.match(cli('archive', 'demo-40').out, /demo-40 is archived already/);
  for (const command of [['block', 'demo-40', 'x'], ['advance', 'demo-40'], ['run', 'demo-40', 'lint'], ['note', 'demo-40', 'reproduce', 'x']]) assert.match(cli(...command).out, /demo-40 is archived, so "\w+" has nothing to work on/, command[0]);
  assert.match(cli('new', 'demo#40', '--title', 'Again').out, /demo-40 exists and is archived/);
  // Names every object answers to are not commands or projects.
  for (const name of ['toString', 'constructor', 'hasOwnProperty']) assert.equal(cli(name).status, 1, name);
  assert.match(cli('new', 'constructor#1', '--title', 'x').out, /Unknown repo "constructor"/);
});

test('the guard sees through cheap disguises, and does not refuse ordinary commands that only say a word', () => {
  assert.equal(cli('new', 'demo#50', '--title', 'Guarded task').status, 0);
  const W = path.join(ROOT, 'worktrees', 'demo-50');
  const I = path.join(ROOT, 'issues', 'demo-50');
  const LIB = path.resolve(path.dirname(BIN), '../lib');
  const refused = (command, cwd = W) => assert.equal(bash(command, cwd).deny, true, `should be refused: ${command}`);
  const allowed = (command, cwd = W) => assert.equal(bash(command, cwd).deny, false, `should be allowed: ${command} (${bash(command, cwd).reason || ''})`);
  // Approval under another spelling of the same command.
  for (const command of ['c\\ig approve demo-50', 'cig ap""prove demo-50', "cig 'approve' demo-50", 'CIG approve demo-50', 'cig --json approve demo-50', 'env -u CLAUDE\\CODE script -qc "c\\ig ap\\prove demo-50" /dev/null']) refused(command);
  // Codeignite's own code as a one-line script.
  refused(`node --input-type=module -e "const g=await import('${LIB}/stages.mjs');g.approve({})"`);
  refused(`node -e "import('${LIB}/pairing.mjs').then(m=>console.log(m.boardKey()))"`);
  // A push that does not say "git push" plainly, or does not name the task.
  for (const command of ['git pu""sh -u origin HEAD', 'git pu\\sh', `git -C ${W} -c a=b push`]) refused(command);
  refused('git push origin --all', REPO);
  refused("git push origin 'refs/heads/me/*:refs/heads/me/*'", REPO);
  refused(`GIT_DIR=${REPO}/.git git push origin --mirror`, tmp);
  // The task's record and proof under another spelling, and the task folder as a whole.
  for (const command of [`echo '{}' > ${I}/"state.json"`, `echo '{}' > ${I}//state.json`, `echo '{}' > ${I}/./state.json`, `echo x > ${I}/st*.json`, `touch ${I}/evidence/999-lint.json`, `sed --in-place s/a/b/ ${I}/state.json`, `sed -Ei s/a/b/ ${I}/state.json`, `rm -rf ${I}`, `mv ${I} /tmp/x`]) refused(command, WORKSPACE);
  // The pairing key by a pattern.
  for (const command of ['cat factory/.board-*', 'cat factory/.b*', "cat factory/.board-k''ey"]) refused(command, WORKSPACE);
  // GitHub writes the plain rule did not name.
  for (const command of ['gh pr --repo acme/demo create --fill', 'gh pr ready', 'gh issue close 50 -R acme/demo', 'gh api repos/acme/demo/issues/50 -X PATCH -f body=x', 'gh api repos/acme/demo/pulls -fhead=x -fbase=main', 'gh api repos/acme/demo/git/refs/heads/x --method patch -f sha=abc', "gh api graphql -f query='mutation{addComment(input:{body:\"50\"}){clientMutationId}}'"]) refused(command);
  // A shell under another spelling of its name, a file tool through a link, and a file tool of another service.
  assert.equal(decide({ tool_name: 'bash', tool_input: { command: 'cig approve demo-50' }, cwd: W }).deny, true);
  fs.symlinkSync(I, path.join(tmp, 'link-to-task'));
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'link-to-task', 'state.json'), content: '{}' }, cwd: WORKSPACE }).deny, true);
  assert.equal(decide({ tool_name: 'mcp__filesystem__write_file', tool_input: { path: path.join(I, 'state.json'), content: '{}' }, cwd: WORKSPACE }).deny, true);
  fs.symlinkSync(path.join(ROOT, '.board-key'), path.join(tmp, 'link-to-key'));
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: path.join(tmp, 'link-to-key') }, cwd: WORKSPACE }).deny, true);
  // A command too long to check is not waved through.
  refused(`echo ${'x'.repeat(60_000)}`);

  // Ordinary work that only says a guarded word.
  for (const command of ['git stash push', 'git commit -m "fix: push handler"', 'git log --grep=push', 'git diff -- lib/push.mjs', 'git commit -m "docs: mention cig approve in passing"'.replace('cig approve', 'the approve step'), 'echo $CLAUDECODE', 'grep CODEIGNITE_ROOT lib', 'gh api repos/acme/demo/pulls/50/comments', 'gh api repos/acme/demo/pulls/50/reviews', 'gh api repos/acme/demo/pulls -X GET -f state=open', "gh api graphql -f query='query{viewer{login}}'", 'gh pr view 50 --json comments']) allowed(command);
  // A file about the key may say its name; where a tool looks is what counts.
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: path.join(WORKSPACE, 'notes.md'), content: 'The key is kept in .board-key.' }, cwd: WORKSPACE }).deny, false);

  // A task whose record cannot be read cannot be checked: nothing goes out meanwhile.
  assert.equal(cli('new', 'demo#51', '--title', 'Task to damage').status, 0);
  const file = path.join(ROOT, 'issues', 'demo-51', 'state.json');
  const good = fs.readFileSync(file, 'utf8');
  write(file, '{broken');
  assert.match(bash('git push -u origin HEAD', path.join(ROOT, 'worktrees', 'demo-51')).reason, /The record of demo-51 cannot be read/);
  write(file, good);
  // An approval written into the record by hand carries no seal.
  const forged = JSON.parse(good);
  Object.assign(forged, { stage: 'approved', approvedSha: sh(path.join(ROOT, 'worktrees', 'demo-51'), 'git rev-parse HEAD'), approvedDraftSha256: null });
  write(file, JSON.stringify(forged));
  assert.equal(bash('git push -u origin HEAD', path.join(ROOT, 'worktrees', 'demo-51')).deny, true);
  write(file, good);
  // The hook itself: an input that is no record of a call ends quietly instead of failing.
  for (const input of ['null', '[]', '5', '', 'not json']) {
    const r = spawnSync('node', [path.resolve(path.dirname(BIN), 'guard.mjs'), 'pre'], { input, encoding: 'utf8' });
    assert.equal(r.status, 0, `${JSON.stringify(input)}: ${r.stderr}`);
  }
  for (const id of ['demo-50', 'demo-51']) assert.equal(cli('archive', id, '--delete-branch').status, 0);
});
