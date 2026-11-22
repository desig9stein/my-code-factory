// Covers the daily report: the recorded facts, the summary text and the plain-English rewrite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/factory.mjs', import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-report-')));
const ROOT = path.join(tmp, 'data');
const WS = path.join(tmp, 'ws');
const APP = path.join(WS, 'app');
const STUB = path.join(tmp, 'stub');
const ASKED = path.join(tmp, 'claude-input.txt');

Object.assign(process.env, {
  FACTORY_ROOT: ROOT,
  FACTORY_WORKSPACE: WS,
  PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
  ASKED,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

const { dayFacts, reportDay, writePlainReport } = await import('../lib/report.mjs');
const { saveState } = await import('../lib/state.mjs');
const { runRecorded } = await import('../lib/evidence.mjs');
const { startServer } = await import('../lib/server.mjs');

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
function sh(cwd, cmd, env = {}) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
}
const cli = (...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: tmp });
  return { status: r.status, out: r.stdout + r.stderr };
};
const stub = (name, body) => {
  write(path.join(STUB, name), `#!/bin/sh\n${body}\n`);
  fs.chmodSync(path.join(STUB, name), 0o755);
};
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOW = new Date();
const TODAY = dayOf(NOW);
const YESTERDAY = dayOf(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1));
const at = (day, hour) => new Date(`${day}T${pad(hour)}:00:00`).toISOString();

before(() => {
  // "--created" returns one opened pull request, "--merged-at" one merged; GH_FAIL switches a failure on.
  stub('gh', `if [ -n "$GH_FAIL" ]; then echo "$GH_FAIL" >&2; exit 4; fi
case "$*" in
  *--created*) echo '[{"number":9,"title":"fix(app): add","url":"https://github.com/acme/app/pull/9","repository":{"nameWithOwner":"acme/app"}}]';;
  *--merged-at*) echo '[{"number":8,"title":"docs(app): readme","url":"https://github.com/acme/app/pull/8","repository":{"nameWithOwner":"acme/app"}}]';;
  *) echo '[]';;
esac`);
  stub('claude', 'echo "$*" > "$ASKED.args"; cat > "$ASKED"; if [ -n "$CLAUDE_FAIL" ]; then echo "not logged in" >&2; exit 1; fi; echo "- I fixed the add function in app."');
  fs.mkdirSync(APP, { recursive: true });
  sh(APP, 'git init -q -b main && git config user.email test@example.com');
  write(path.join(APP, 'a.txt'), '1');
  sh(APP, 'git add -A && git commit -q -m "chore(repo): seed"', { GIT_AUTHOR_DATE: `${YESTERDAY}T10:00:00`, GIT_COMMITTER_DATE: `${YESTERDAY}T10:00:00` });
  write(path.join(APP, 'a.txt'), '2');
  sh(APP, 'git add -A && git commit -q -m "fix(app): return the sum"');
  write(path.join(APP, 'b.txt'), '1');
  sh(APP, 'git add -A && git commit -q -m "chore(app): by someone else" --author="Other <other@example.com>"');
  write(path.join(ROOT, 'repos.json'), JSON.stringify({ defaults: {}, repos: { app: { dir: 'app', remote: 'acme/app', baseBranch: 'main', install: '', gates: [{ name: 'test', cmd: 'true' }] } } }));
  saveState({
    id: 'app-7', kind: 'issue', repo: 'app', issue: 7, title: 'add returns the wrong sum', url: 'https://github.com/acme/app/issues/7', type: 'bug', stage: 'pr-opened', prUrl: 'https://github.com/acme/app/pull/9', worktree: APP, branch: 'main', base: 'main',
    history: [{ stage: 'intake', at: at(YESTERDAY, 9), note: '' }, { stage: 'plan', at: at(YESTERDAY, 10), note: '' }, { stage: 'implement', at: at(TODAY, 0), note: '' }, { stage: 'ready', at: at(TODAY, 0), note: '' }, { stage: 'approved', at: at(TODAY, 0), note: '' }, { stage: 'pr-opened', at: at(TODAY, 0), note: '' }],
  });
  saveState({ id: 'app-3', kind: 'issue', repo: 'app', issue: 3, title: 'old task', stage: 'plan', worktree: APP, branch: 'main', base: 'main', archived: true, history: [{ stage: 'intake', at: at(YESTERDAY, 8), note: '' }] });
  runRecorded({ id: 'app-7', worktree: APP }, { name: 'test', kind: 'gate', cmd: 'true', cwd: APP });
  runRecorded({ id: 'app-7', worktree: APP }, { name: 'test', kind: 'gate', cmd: 'false', cwd: APP });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the day is today, yesterday or a date, and anything else is rejected', () => {
  assert.equal(reportDay(), TODAY);
  assert.equal(reportDay('yesterday'), YESTERDAY);
  assert.equal(reportDay('2026-01-31'), '2026-01-31');
  assert.throws(() => reportDay('last week'), /"last week" is not a day\. Use today, yesterday, or a date such as/);
});

test('a task reports the stages it passed on the day, its milestones and its check runs', () => {
  const { tasks } = dayFacts(TODAY);
  assert.equal(tasks.length, 1);
  assert.deepEqual({ ...tasks[0] }, { id: 'app-7', kind: 'issue', project: 'app', remote: 'acme/app', number: 7, title: 'add returns the wrong sum', url: 'https://github.com/acme/app/issues/7', prUrl: 'https://github.com/acme/app/pull/9', from: 'plan', to: 'pr-opened', milestones: ['made ready for your review', 'approved by you', 'pull request opened'], checks: { passed: 1, failed: 1 } });
});

test('a task that did not move on the day is left out, and an archived one is found on its own day', () => {
  const { tasks } = dayFacts(YESTERDAY);
  assert.deepEqual(tasks.map((t) => [t.id, t.to, t.milestones]), [['app-3', 'intake', ['started']], ['app-7', 'plan', ['started']]]);
});

test('commits are yours only, from the day only', () => {
  assert.deepEqual(dayFacts(TODAY).commits.map((c) => [c.project, c.count, c.commits.map((x) => x.subject)]), [['app', 1, ['fix(app): return the sum']]]);
  assert.deepEqual(dayFacts(YESTERDAY).commits[0].commits.map((x) => x.subject), ['chore(repo): seed']);
});

test('the summary states the counts, the task movement and the pull requests', () => {
  const { summary, pullRequests } = dayFacts(TODAY);
  assert.deepEqual(pullRequests.opened.map((p) => p.number), [9]);
  assert.match(summary, /You worked in 1 project: 1 factory task, 1 commit, 1 pull request opened, 1 merged\./);
  assert.match(summary, /- app #7, "add returns the wrong sum": made ready for your review, approved by you, pull request opened, moved from plan to PR opened\. Checks run: 1 passed, 1 failed\. https:\/\/github\.com\/acme\/app\/pull\/9/);
  assert.match(summary, /- Merged acme\/app#8, "docs\(app\): readme"\./);
  assert.match(summary, /- app: 1 commit\. fix\(app\): return the sum\./);
});

test('a day with nothing recorded says so, and names GitHub when it could not be read', () => {
  process.env.GH_FAIL = 'HTTP 401';
  try {
    const empty = dayFacts('2020-01-01');
    assert.match(empty.summary, /^Wednesday, January 1, 2020/);
    assert.match(empty.summary, /Nothing was recorded for this day/);
    assert.match(empty.summary, /GitHub pull requests are not included: HTTP 401\. Check "gh auth status"\./);
  } finally {
    delete process.env.GH_FAIL;
  }
});

test('the plain-English rewrite sends only the summary to Claude, with no tools', async () => {
  const facts = dayFacts(TODAY);
  assert.equal(await writePlainReport(facts), '- I fixed the add function in app.');
  assert.equal(fs.readFileSync(ASKED, 'utf8').trim().endsWith(facts.summary.trim()), true);
  const args = fs.readFileSync(`${ASKED}.args`, 'utf8');
  assert.match(args, /^-p --model sonnet --tools {2}--strict-mcp-config --no-session-persistence --system-prompt /);
  assert.match(args, /Use only the facts given/);
});

test('a failing Claude CLI reports why, and the summary still prints', async () => {
  process.env.CLAUDE_FAIL = '1';
  try {
    await assert.rejects(writePlainReport(dayFacts(TODAY)), /Claude could not write the report: /);
    const r = cli('report', 'today');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /You worked in 1 project/);
  } finally {
    delete process.env.CLAUDE_FAIL;
  }
});

test('the CLI prints the report, and --plain adds the rewrite', () => {
  const r = cli('report', 'today', '--plain');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /In plain English \(written by Claude from the facts above\):\n\n- I fixed the add function in app\./);
  assert.equal(JSON.parse(cli('report', 'yesterday', '--json').out).day, YESTERDAY);
  assert.equal(cli('report', 'someday').status, 1);
});

test('the server serves the report and writes the plain version only with the token', async () => {
  const server = await startServer(0, { pairing: false, followEvery: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = /__factoryToken="([0-9a-f]{32})"/.exec(await (await fetch(`${base}/`)).text())[1];
    const report = await (await fetch(`${base}/api/report?day=${TODAY}`)).json();
    assert.equal(report.tasks[0].id, 'app-7');
    assert.equal((await fetch(`${base}/api/report?day=nope`)).status, 400);
    const plain = (headers) => fetch(`${base}/api/report/write`, { method: 'POST', headers, body: JSON.stringify({ day: TODAY }) });
    assert.equal((await plain({})).status, 403);
    assert.deepEqual(await (await plain({ 'x-factory-token': token })).json(), { text: '- I fixed the add function in app.' });
  } finally {
    server.close();
  }
});
