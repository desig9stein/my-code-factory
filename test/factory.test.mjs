// Drives one bug through every stage in a throwaway workspace.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/factory.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-')));
const WORKSPACE = path.join(tmp, 'ws');
const ROOT = path.join(WORKSPACE, 'factory');
const REPO = path.join(WORKSPACE, 'demo');
const ID = 'demo-7';
const WT = path.join(ROOT, 'worktrees', ID);
const ISSUE = path.join(ROOT, 'issues', ID);

// A board port exported in the developer's shell must not change what the tests expect.
delete process.env.FACTORY_PORT;
// Lets nested "node --test" runs report their own exit code.
delete process.env.NODE_TEST_CONTEXT;
Object.assign(process.env, {
  FACTORY_ROOT: ROOT,
  FACTORY_WORKSPACE: WORKSPACE,
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

test('a push on the factory branch is refused before approval', () => {
  assert.equal(bash('git push -u origin HEAD', WT).deny, true);
  assert.equal(bash(`cd ${WT} && git push`).deny, true);
  assert.equal(bash('gh pr create --head me/fix-7-add-returns-the-difference').deny, true);
  assert.equal(bash('gh issue comment 7 -R acme/demo --body hi').deny, true);
});

test('a push on a branch the factory does not own is allowed', () => {
  assert.equal(bash('git push origin main', REPO).deny, false);
  assert.equal(bash('gh issue comment 8 -R acme/demo --body hi').deny, false);
});

test('an agent cannot approve or write state and evidence', () => {
  assert.equal(bash(`node factory/bin/factory.mjs approve ${ID}`).deny, true);
  assert.equal(bash(`echo '{}' > factory/issues/${ID}/state.json`).deny, true);
  assert.equal(bash(`cat factory/issues/${ID}/state.json 2>/dev/null`).deny, false);
  // The same actions written another way: a quoted word, a file named from inside its folder, the GitHub API.
  assert.equal(bash(`node factory/bin/factory.mjs "approve" ${ID}`).deny, true);
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

test('an MCP push naming the factory branch is refused', () => {
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
  assert.equal(hook(`factory status ${ID}`).status, 0);
  assert.notEqual(fs.statSync(data).mtimeMs, 0);
  // A second task call right after does not rebuild it again: the rewrite is limited to twice a minute.
  const fresh = fs.statSync(data).mtimeMs;
  assert.equal(hook(`factory status ${ID}`).status, 0);
  assert.equal(fs.statSync(data).mtimeMs, fresh);
});

test('tokens count the calls that acted on the issue once each, plus its subagents', async () => {
  const { issueTokens, linkSession } = await import('../lib/tokens.mjs');
  const transcript = path.join(tmp, 'sess.jsonl');
  const row = (id, timestamp, output, command = `factory run ${ID} lint`) =>
    JSON.stringify({ type: 'assistant', timestamp, message: { id, content: [{ type: 'tool_use', input: { command } }], usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output } } });
  const later = new Date(Date.now() + 60_000).toISOString();
  write(transcript, [row('m0', '2000-01-01T00:00:00.000Z', 999), row('m1', later, 5), row('m1', later, 5), row('m2', later, 7), row('m3', later, 500, 'npm test in another repo'), '{"type":"user","usage":1}'].join('\n'));
  write(path.join(tmp, 'sess/subagents/agent-a.jsonl'), [JSON.stringify({ type: 'user', message: { content: `Verify factory issue ${ID}.` } }), row('s1', later, 3, 'ls')].join('\n'));
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
