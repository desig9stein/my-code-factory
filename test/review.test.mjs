// Drives one pull request through the review stages in a throwaway workspace.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/factory.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-review-')));
const WORKSPACE = path.join(tmp, 'ws');
const ROOT = path.join(WORKSPACE, 'factory');
const REPO = path.join(WORKSPACE, 'demo');
const ID = 'demo-pr-9';
const WT = path.join(ROOT, 'worktrees', ID);
const ISSUE = path.join(ROOT, 'issues', ID);
const PR_JSON = path.join(tmp, 'pr.json');

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
const { loadState } = await import('../lib/state.mjs');
const { boardData } = await import('../lib/board.mjs');

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
const bash = (command, cwd = WORKSPACE) => decide({ tool_name: 'Bash', tool_input: { command }, cwd });
const POST = 'gh pr review 9 -R acme/demo --request-changes --body-file review-body.md';
const DRAFT = `Verdict: request-changes\n\nThe fix is right.\n\n## Blocking\n\n1. \`lib/add.mjs:1\` — no test covers negative numbers. ${'Evidence and fix. '.repeat(10)}\n`;

// Writes the PR JSON for the current head of the PR branch and returns that head.
function prJson() {
  const oid = sh(REPO, 'git rev-parse pr-branch');
  write(PR_JSON, JSON.stringify({ number: 9, title: 'fix(add): return the sum', body: 'Fixes add.', author: { login: 'someone' }, url: 'https://github.com/acme/demo/pull/9', state: 'OPEN', baseRefName: 'main', headRefName: 'pr-branch', headRefOid: oid, files: [{ path: 'lib/add.mjs', additions: 1, deletions: 1 }] }));
  return oid;
}

before(() => {
  write(
    path.join(ROOT, 'repos.json'),
    JSON.stringify({
      defaults: { install: '', branchPattern: 'me/{type}-{n}-{slug}', maxCommits: 3, testable: true },
      repos: { demo: { remote: 'acme/demo', baseBranch: 'main', gates: [{ name: 'lint', cmd: 'npm run lint' }, { name: 'test', cmd: 'npm test' }] } },
    }),
  );
  write(path.join(WORKSPACE, 'WORK_LOG.md'), '# Work log\n\n## 2020-01-01\n- old line\n');
  const remote = path.join(tmp, 'acme/demo.git');
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  sh(tmp, `git init -q --bare -b main ${remote}`);
  fs.mkdirSync(REPO, { recursive: true });
  sh(REPO, 'git init -q -b main');
  write(path.join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { lint: 'node -e "process.exit(1)"', test: 'node --test' } }));
  write(path.join(REPO, 'lib/add.mjs'), 'export const add = (a, b) => a - b;\n');
  write(path.join(REPO, 'test/smoke.test.mjs'), "import { test } from 'node:test';\ntest('loads', () => {});\n");
  sh(REPO, `git add -A && git commit -q -m "chore(repo): seed" && git remote add origin ${remote} && git push -q -u origin main`);
  sh(REPO, 'git checkout -q -b pr-branch');
  write(path.join(REPO, 'lib/add.mjs'), 'export const add = (a, b) => a + b;\n');
  sh(REPO, 'git commit -q -am "fix(add): return the sum" && git push -q origin pr-branch:refs/pull/9/head && git checkout -q main');
});

test('review checks out the PR head detached, with no branch to push', () => {
  const oid = prJson();
  const r = cli('review', 'demo#9', '--from', PR_JSON);
  assert.equal(r.status, 0, r.out);
  assert.equal(sh(WT, 'git rev-parse HEAD'), oid);
  assert.equal(sh(WT, 'git rev-parse --abbrev-ref HEAD'), 'HEAD');
  const s = loadState(ID);
  assert.deepEqual([s.kind, s.stage, s.author, s.base], ['review', 'intake', 'someone', 'main']);
  assert.match(fs.readFileSync(path.join(ISSUE, 'pr.md'), 'utf8'), /lib\/add\.mjs \(\+1 -1\)/);
});

test('a push from a review worktree is always refused', () => {
  assert.match(bash('git push origin HEAD:pr-branch', WT).reason, /someone else's pull request/);
});

test('checks need every gate run at the PR head, and accept a failing gate', () => {
  assert.equal(cli('advance', ID).status, 0);
  assert.match(cli('advance', ID).out, /Gate "lint" is not-run/);
  assert.equal(cli('run', ID, 'lint').status, 1);
  assert.equal(cli('run', ID, 'test').status, 0);
  assert.equal(cli('advance', ID).status, 0);
  assert.equal(loadState(ID).stage, 'draft');
  assert.deepEqual(boardData().issues[0].gates.map((g) => [g.status, g.verifier]), [['failed', null], ['passed', null]]);
});

test('the draft needs a verdict line and a body', () => {
  assert.match(cli('advance', ID).out, /review\.md is missing/);
  write(path.join(ISSUE, 'review.md'), 'Looks good to me.\n');
  const r = cli('advance', ID);
  assert.match(r.out, /Verdict: approve \| request-changes \| comment/);
  assert.match(r.out, /too short/);
  write(path.join(ISSUE, 'review.md'), DRAFT);
  assert.equal(cli('advance', ID).status, 0);
  assert.equal(boardData().issues[0].reviewVerdict, 'request-changes');
});

test('posting is refused until the draft is approved', () => {
  assert.equal(bash(POST).deny, true);
  assert.equal(bash('gh api repos/acme/demo/pulls/9/reviews -f event=APPROVE').deny, true);
  const mcp = decide({ tool_name: 'mcp__claude_ai_Github_Custom__pull_request_review_write', tool_input: { owner: 'acme', repo: 'demo', pullNumber: 9 }, cwd: WORKSPACE });
  assert.equal(mcp.deny, true);
  assert.equal(bash('gh pr review 10 -R acme/demo --approve').deny, false);
});

test('the board approves only the draft it showed', async () => {
  const { startServer } = await import('../lib/server.mjs');
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = /__factoryToken="([0-9a-f]{32})"/.exec(await (await fetch(`${base}/`)).text())[1];
    const post = (headers, body) => fetch(`${base}/api/approve`, { method: 'POST', headers, body: JSON.stringify(body) });
    const key = boardData().issues[0].approvalKey;
    assert.match(key, /^[0-9a-f]{40}:[0-9a-f]{64}$/);
    assert.equal((await post({}, { id: ID, key })).status, 403);
    write(path.join(ISSUE, 'review.md'), DRAFT.replace('The fix is right.', 'The fix is wrong.'));
    const stale = await post({ 'x-factory-token': token }, { id: ID, key });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /changed since the board showed it/);
    assert.equal(loadState(ID).stage, 'ready');
    write(path.join(ISSUE, 'review.md'), DRAFT);
    assert.equal(bash(POST).deny, true);
    assert.equal((await post({ 'x-factory-token': token }, { id: ID, key })).status, 200);
    assert.equal(loadState(ID).stage, 'approved');
    assert.equal(bash(POST).deny, false);
    assert.equal(boardData().issues[0].approvalKey, null);
  } finally {
    server.close();
  }
});

test('a draft edited after approval is refused again', () => {
  write(path.join(ISSUE, 'review.md'), DRAFT.replace('request-changes', 'approve'));
  assert.equal(bash(POST).deny, true);
  write(path.join(ISSUE, 'review.md'), DRAFT);
  assert.equal(bash(POST).deny, false);
});

test('posted records the review in the work log', () => {
  assert.equal(cli('posted', ID).status, 0);
  assert.equal(loadState(ID).stage, 'posted');
  assert.match(fs.readFileSync(path.join(WORKSPACE, 'WORK_LOG.md'), 'utf8'), /- `demo` — review of \[#9\]\(https:\/\/github\.com\/acme\/demo\/pull\/9\).*review posted \(request-changes\)\./);
});

test('refresh moves to a new PR head and sends the review back to checks', () => {
  assert.match(cli('refresh', ID, '--from', PR_JSON).out, /no new commits/);
  sh(REPO, 'git checkout -q pr-branch');
  write(path.join(REPO, 'lib/extra.mjs'), 'export const x = 1;\n');
  sh(REPO, 'git add -A && git commit -q -m "test(add): cover negatives" && git push -q -f origin pr-branch:refs/pull/9/head && git checkout -q main');
  const oid = prJson();
  assert.match(cli('refresh', ID, '--from', PR_JSON).out, /PR head moved/);
  assert.equal(sh(WT, 'git rev-parse HEAD'), oid);
  const s = loadState(ID);
  assert.deepEqual([s.stage, s.approvedSha], ['checks', null]);
  assert.equal(bash(POST).deny, true);
  assert.deepEqual(boardData().issues[0].gates.map((g) => g.status), ['stale', 'stale']);
});

test('archive removes the review worktree and keeps the repo branches', () => {
  const branches = sh(REPO, 'git branch --list');
  assert.equal(cli('archive', ID, '--delete-branch').status, 0);
  assert.equal(fs.existsSync(WT), false);
  assert.equal(sh(REPO, 'git branch --list'), branches);
});

test('agents cannot reach the board, where approval happens', () => {
  assert.equal(bash('curl -s -X POST http://127.0.0.1:4317/api/approve -d {}').deny, true);
  assert.equal(bash('open http://localhost:4317/').deny, true);
  assert.equal(decide({ tool_name: 'mcp__playwright__browser_navigate', tool_input: { url: 'http://127.0.0.1:4317/' }, cwd: WORKSPACE }).deny, true);
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'notes.md'), content: 'see http://127.0.0.1:4317/' }, cwd: WORKSPACE }).deny, false);
  assert.equal(bash('curl -s http://127.0.0.1:3000/').deny, false);
  assert.equal(bash('FACTORY_PORT=4400 node factory/bin/factory.mjs board').deny, true);
  assert.equal(bash('node factory/bin/factory.mjs serve').deny, true);
  assert.equal(bash('node factory/bin/factory.mjs board --no-open').deny, false);
});
