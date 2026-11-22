// Covers the loop after a pull request opens: what GitHub says about it, what the board shows, and what
// reaches the agent only when the user sends it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-followup-')));
const ROOT = path.join(tmp, 'data');
const WS = path.join(tmp, 'ws');
const STUB = path.join(tmp, 'stub');
const VIEW = path.join(tmp, 'view.json');
const INLINE = path.join(tmp, 'inline.json');
delete process.env.CODEIGNITE_PORT;
Object.assign(process.env, { CODEIGNITE_ROOT: ROOT, CODEIGNITE_WORKSPACE: WS, PATH: `${STUB}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), GH_VIEW: VIEW, GH_INLINE: INLINE });

const { feedbackView, fetchFeedback, readFeedback, sendFeedback } = await import('../lib/followup.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { recordPr } = await import('../lib/stages.mjs');
const { getRepo } = await import('../lib/registry.mjs');
const { formatBrief, stageBrief } = await import('../lib/workflow.mjs');
const { boardData } = await import('../lib/board.mjs');
const { startServer } = await import('../lib/server.mjs');

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
fs.mkdirSync(path.join(WS, 'demo'), { recursive: true });
write(path.join(ROOT, 'config.json'), JSON.stringify({ workspace: WS }));
write(path.join(ROOT, 'repos.json'), JSON.stringify({ defaults: {}, repos: { demo: { dir: 'demo', remote: 'acme/demo', baseBranch: 'main', install: '', gates: [{ name: 'test', cmd: 'true' }] } } }));
// The stand-in for the GitHub CLI answers "pr view" and "api" from files, or fails when told to.
write(path.join(STUB, 'gh'), '#!/bin/sh\nif [ -n "$GH_FAIL" ]; then echo "could not resolve host: api.github.com" >&2; exit 1; fi\ncase "$1" in pr) cat "$GH_VIEW";; api) cat "$GH_INLINE";; *) echo "[]";; esac\n');
fs.chmodSync(path.join(STUB, 'gh'), 0o755);

// A real repository on the task's branch: recording a pull request checks that the branch is the approved commit.
const gitIn = (...args) => { const r = spawnSync('git', args, { cwd: path.join(WS, 'demo'), encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
gitIn('init', '-q', '-b', 'fix');
gitIn('commit', '-q', '--allow-empty', '-m', 'feat: one');
const HEAD = gitIn('rev-parse', 'HEAD');
const URL = 'https://github.com/acme/demo/pull/9';
function task(number, extra = {}) {
  const id = `demo-${number}`;
  saveState({ id, repo: 'demo', issue: number, kind: 'issue', type: 'bug', title: `Task ${number}`, stage: 'pr-opened', stageSince: new Date().toISOString(), worktree: path.join(WS, 'demo'), branch: 'fix', base: 'main', history: [], blocked: null, gatesSha: HEAD, approvedSha: HEAD, prUrl: URL, ...extra }, { replace: true });
  return id;
}
const X = '<img src=x onerror=alert(1)>';
const view = (over = {}) => ({
  state: 'OPEN', mergedAt: null, author: { login: 'me' }, headRefOid: HEAD, reviewDecision: 'CHANGES_REQUESTED',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'verify (ubuntu)', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/demo/actions/runs/1/job/2' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'javascript:alert(1)' },
    { __typename: 'CheckRun', name: 'deploy preview', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'coverage', state: 'ERROR', targetUrl: 'https://example.com/elsewhere' },
  ],
  reviews: [
    { author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: `Please handle negative numbers. ${X}`, submittedAt: '2026-01-02T10:00:00Z' },
    { author: { login: 'lead' }, state: 'APPROVED', body: '', submittedAt: '2026-01-02T11:00:00Z' },
    { author: { login: 'me' }, state: 'COMMENTED', body: 'my own note', submittedAt: '2026-01-02T12:00:00Z' },
    { author: { login: 'silent' }, state: 'COMMENTED', body: '', submittedAt: '2026-01-02T12:30:00Z' },
  ],
  comments: [{ author: { login: 'bot' }, body: 'Coverage dropped by 2%.', createdAt: '2026-01-02T09:00:00Z', url: 'https://github.com/acme/demo/pull/9#issuecomment-1' }],
  ...over,
});
const inline = [{ user: { login: 'reviewer' }, body: 'This branch is never taken.', path: 'src/add.mjs', line: 4, created_at: '2026-01-02T10:05:00Z', html_url: 'https://github.com/acme/demo/pull/9#discussion_r1' }, { user: { login: 'me' }, body: 'fixed', path: 'src/add.mjs', line: 4, created_at: '2026-01-02T10:06:00Z' }];
const answer = (v = view(), lines = inline) => { write(VIEW, JSON.stringify(v)); write(INLINE, JSON.stringify(lines)); };

test('what GitHub reports is reduced to failed checks and what other people wrote', () => {
  const read = readFeedback(view(), inline);
  assert.deepEqual(read.checks.map((c) => [c.name, c.result]), [['verify (ubuntu)', 'failed'], ['lint', 'passed'], ['deploy preview', 'pending'], ['coverage', 'failed']]);
  // Only GitHub addresses become links.
  assert.deepEqual(read.checks.map((c) => c.url), ['https://github.com/acme/demo/actions/runs/1/job/2', null, null, null]);
  assert.deepEqual(read.notes.map((n) => [n.author, n.kind]), [['bot', 'comment'], ['reviewer', 'changes requested'], ['reviewer', 'comment on a line'], ['lead', 'approved']]);
  assert.deepEqual([read.state, read.head, read.decision], ['open', HEAD, 'CHANGES_REQUESTED']);
  assert.equal(readFeedback({ state: 'MERGED' }).state, 'merged');
  assert.equal(readFeedback({ state: 'CLOSED' }).state, 'closed');
  assert.deepEqual(readFeedback({}).checks, []);
});

test('a failed check or a reviewer\'s words put the task in the user\'s hands, with a text to send', () => {
  const id = task(1);
  assert.equal(feedbackView(loadState(id)), null);
  answer();
  fetchFeedback(id);
  const shown = feedbackView(loadState(id));
  assert.deepEqual([shown.needsYou, shown.failed.length, shown.pending, shown.passed, shown.notes.length, shown.approvals], [true, 2, 1, 1, 3, 1]);
  assert.match(shown.draft, /^Checks that failed on the pull request:\n- verify \(ubuntu\) \(https:\/\/github\.com\/acme\/demo\/actions\/runs\/1\/job\/2\)\n- coverage\n\nReview feedback:\n- bot: Coverage dropped by 2%\.\n- reviewer: Please handle negative numbers\./);
  assert.match(shown.draft, /- reviewer, src\/add\.mjs:4: This branch is never taken\.$/);
  const onBoard = boardData().issues.find((i) => i.id === id).followup;
  assert.equal(onBoard.needsYou, true);
  // A pull request with nothing wrong does not ask for the user.
  answer(view({ statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }], reviews: [], comments: [], reviewDecision: 'REVIEW_REQUIRED' }), []);
  fetchFeedback(id);
  assert.deepEqual([feedbackView(loadState(id)).needsYou, feedbackView(loadState(id)).passed], [false, 1]);
  answer(view({ state: 'MERGED' }));
  fetchFeedback(id);
  assert.deepEqual([feedbackView(loadState(id)).state, feedbackView(loadState(id)).needsYou], ['merged', false]);
});

test('when GitHub cannot be asked the last answer stays, with the reason', () => {
  const id = task(2);
  answer();
  fetchFeedback(id);
  process.env.GH_FAIL = '1';
  try {
    fetchFeedback(id);
  } finally {
    delete process.env.GH_FAIL;
  }
  const shown = feedbackView(loadState(id));
  assert.match(shown.error, /GitHub could not be asked: could not resolve host/);
  assert.equal(shown.failed.length, 2);
  assert.throws(() => fetchFeedback(task(3, { prUrl: null })), /demo-3 has no pull request recorded/);
});

test('the user\'s text sends the task back to the agent, and the update answers it', () => {
  const id = task(4);
  answer();
  fetchFeedback(id);
  assert.throws(() => sendFeedback(id, '   '), /Say what the agent should fix/);
  assert.throws(() => sendFeedback(id, 'x'.repeat(6001)), /at most 6000 characters/);
  const sent = sendFeedback(id, 'Handle negative numbers.\nIgnore the coverage bot.');
  assert.deepEqual([sent.stage, sent.gatesSha, sent.approvedSha], ['implement', null, null]);
  assert.equal(loadState(id).history.at(-1).note, 'Sent back with feedback from the pull request.');
  assert.throws(() => sendFeedback(id, 'again'), /demo-4 is at "implement"\. Feedback on a pull request is sent when the pull request is open/);
  // The agent's brief carries the user's words, not GitHub's.
  const brief = formatBrief(stageBrief(loadState(id), getRepo('demo')));
  assert.match(brief, /The pull request of this task is open and needs changes\..*Do not push: the user approves the fix first\.\n\s+Handle negative numbers\.\n\s+Ignore the coverage bot\./s);
  assert.ok(!brief.includes('never taken'));
  // Away from the open pull request the board does not ask for the user about it.
  assert.equal(feedbackView(loadState(id)).needsYou, false);
  // The fix is approved and goes out: the passed-on text is answered, and what was sent is not shown as new again.
  const state = loadState(id);
  gitIn('commit', '-q', '--allow-empty', '-m', 'fix: two');
  const pushed = gitIn('rev-parse', 'HEAD');
  Object.assign(state, { stage: 'approved', approvedSha: pushed, gatesSha: pushed });
  saveState(state);
  recordPr(loadState(id), getRepo('demo'), URL);
  const after = loadState(id);
  assert.deepEqual([after.stage, after.prFeedback, typeof after.prFeedbackSentAt], ['pr-opened', undefined, 'string']);
  // The stored answer is about the commit before the fix: its failed checks say nothing about the new one.
  assert.deepEqual([feedbackView(after).failed.length, feedbackView(after).notes.length, feedbackView(after).needsYou], [0, 0, false]);
  // A reviewer who writes after that is news.
  answer(view({ headRefOid: pushed, statusCheckRollup: [], reviews: [{ author: { login: 'reviewer' }, state: 'COMMENTED', body: 'One more thing.', submittedAt: new Date(Date.now() + 60_000).toISOString() }], comments: [] }), []);
  fetchFeedback(id);
  assert.deepEqual([feedbackView(loadState(id)).notes.map((n) => n.body), feedbackView(loadState(id)).needsYou], [['One more thing.'], true]);
  // A moved branch is not what was approved, so nothing is recorded for it; neither is an address of another repository.
  gitIn('reset', '-q', '--hard', HEAD);
  const stale = task(40, { stage: 'approved', prUrl: null });
  gitIn('branch', '-f', 'elsewhere', pushed);
  assert.throws(() => recordPr(Object.assign(loadState(stale), { branch: 'elsewhere' }), getRepo('demo'), URL), /changed after it was approved: the commit, the branch or pr-body\.md is not what was approved/);
  assert.throws(() => recordPr(loadState(stale), { ...getRepo('demo'), remote: 'acme/my.repo' }, 'https://github.com/acme/myXrepo/pull/5'), /Expected a PR URL/);
  assert.throws(() => recordPr(loadState(stale), getRepo('demo'), 'https://github.com/acme/demo/pull/0'), /Expected a PR URL/);
  assert.equal(recordPr(loadState(stale), getRepo('demo'), URL).stage, 'pr-opened');
});

test('the board asks GitHub on request and sends feedback only with its token', async () => {
  const server = await startServer(0, { pairing: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = /__factoryToken="([0-9a-f]+)"/.exec(await (await fetch(base)).text())[1];
  const call = (pathname, body, headers = { 'X-Factory-Token': token }) => fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const board = async () => { const text = await (await fetch(`${base}/board-data.js`)).text(); return JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))); };
  try {
    const id = task(5);
    answer();
    assert.equal((await call('/api/followup/check', { id }, {})).status, 403);
    assert.equal((await call('/api/followup/send', { id, note: 'x' }, {})).status, 403);
    assert.equal((await call('/api/followup/check', { id })).status, 200);
    const shown = (await board()).issues.find((i) => i.id === id);
    assert.deepEqual([shown.followup.needsYou, shown.followup.failed.length], [true, 2]);
    assert.match((await (await call('/api/followup/send', { id, note: '' })).json()).error, /Say what the agent should fix/);
    assert.match((await (await call('/api/followup/check', { id: '../x' })).json()).error, /Invalid issue id/);
    assert.equal((await call('/api/followup/send', { id, note: 'Handle negative numbers.' })).status, 200);
    const sent = (await board()).issues.find((i) => i.id === id);
    assert.deepEqual([sent.stage, sent.followup.needsYou], ['implement', false]);
    assert.match(sent.brief, /Handle negative numbers\./);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
