// Covers what happens when several processes work on one task at once, and that the board keeps answering
// while a program it waits for is slow.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/factory.mjs', import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-concurrency-')));
const ROOT = path.join(tmp, 'data');
const WS = path.join(tmp, 'ws');
const STUB = path.join(tmp, 'stub');
delete process.env.FACTORY_PORT;
delete process.env.NODE_TEST_CONTEXT;
Object.assign(process.env, { FACTORY_ROOT: ROOT, FACTORY_WORKSPACE: WS, PATH: `${STUB}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });

const { withLock, withTask, withSettings } = await import('../lib/lock.mjs');
const { loadState, saveState, sync } = await import('../lib/state.mjs');
const { listEvidence, verifyChain } = await import('../lib/evidence.mjs');
const { updateProject } = await import('../lib/setup.mjs');
const { getRepo } = await import('../lib/registry.mjs');
const { createLanes } = await import('../lib/offload.mjs');
const { startServer } = await import('../lib/server.mjs');

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const sh = (cwd, cmd) => {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};
// Runs the CLI without waiting, so several commands overlap.
const cli = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  child.on('close', (status) => resolve({ status, out }));
});

// A real repository, so a task has a commit to bind its evidence to.
const REPO = path.join(WS, 'demo');
fs.mkdirSync(REPO, { recursive: true });
sh(REPO, 'git init -q -b main && echo one > a.txt && git add -A && git commit -q -m "feat: one"');
const HEAD = sh(REPO, 'git rev-parse HEAD');
write(path.join(ROOT, 'config.json'), JSON.stringify({ workspace: WS }));
write(path.join(ROOT, 'repos.json'), JSON.stringify({ defaults: {}, repos: { demo: { dir: 'demo', remote: 'acme/demo', baseBranch: 'main', install: '', gates: [{ name: 'test', cmd: 'true' }] } } }));
// The stand-in for the GitHub CLI answers after two seconds, like a slow network.
write(path.join(STUB, 'gh'), '#!/bin/sh\nsleep 2\necho "[]"\n');
fs.chmodSync(path.join(STUB, 'gh'), 0o755);

function task(number, stage = 'implement', extra = {}) {
  const id = `demo-${number}`;
  saveState({ id, repo: 'demo', issue: number, kind: 'issue', type: 'bug', title: `Task ${number}`, stage, stageSince: new Date().toISOString(), worktree: REPO, branch: 'main', base: 'main', baseSha: HEAD, history: [], blocked: null, gatesSha: null, approvedSha: null, prUrl: null, ...extra }, { replace: true });
  return id;
}
const lockFile = (id) => path.join(ROOT, 'issues', id, '.lock');
const foreign = (id, owner) => write(lockFile(id), JSON.stringify(owner));

test('a lock is entered again by its holder, refused to others, and taken over from a process that died', () => {
  const file = path.join(tmp, 'locks', 'a.lock');
  assert.equal(withLock(file, () => withLock(file, () => fs.existsSync(file))), true);
  assert.equal(fs.existsSync(file), false);
  // Another live holder: a try returns at once, a wait gives up and names the holder.
  write(file, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
  assert.equal(withLock(file, () => 'ran', { tryOnly: true, busy: 'busy' }), 'busy');
  assert.throws(() => withLock(file, () => 'ran', { wait: 150, what: 'app-1' }), new RegExp(`Another factory command \\(process ${process.ppid}\\) is changing app-1 and did not finish`));
  assert.equal(fs.existsSync(file), true);
  // A holder that no longer runs, and one that held far too long, lose the lock.
  write(file, JSON.stringify({ pid: 2 ** 22 + 4321, at: new Date().toISOString() }));
  assert.equal(withLock(file, () => 'ran', { wait: 500 }), 'ran');
  write(file, JSON.stringify({ pid: process.ppid, at: '2020-01-01T00:00:00.000Z' }));
  fs.utimesSync(file, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
  assert.equal(withLock(file, () => 'ran', { wait: 500 }), 'ran');
  // An error inside leaves no lock behind.
  assert.throws(() => withLock(file, () => { throw new Error('inside'); }), /inside/);
  assert.equal(fs.existsSync(file), false);
});

test('a state read before another writer saved is refused instead of dropping that writer\'s change', () => {
  const id = task(1);
  const mine = loadState(id);
  const theirs = loadState(id);
  theirs.history.push({ stage: 'implement', at: new Date().toISOString(), note: 'theirs' });
  saveState(theirs);
  mine.history.push({ stage: 'implement', at: new Date().toISOString(), note: 'mine' });
  assert.throws(() => saveState(mine), /demo-1 was changed by another factory command while this one worked\. Nothing was written/);
  assert.deepEqual(loadState(id).history.map((h) => h.note), ['theirs']);
  // Read again, change, save: both changes are there.
  const again = loadState(id);
  again.history.push({ stage: 'implement', at: new Date().toISOString(), note: 'mine' });
  saveState(again);
  assert.deepEqual([loadState(id).history.map((h) => h.note), loadState(id).rev], [['theirs', 'mine'], 3]);
});

test('commands that record evidence at the same moment get their own numbers and keep the chain whole', async () => {
  const id = task(2);
  const results = await Promise.all(Array.from({ length: 8 }, (_, n) => cli('note', id, 'reproduce', `Checked by hand, run number ${n}, and saw the wrong sum on screen.`)));
  assert.deepEqual(results.map((r) => r.status), Array(8).fill(0), results.map((r) => r.out).join('\n'));
  const records = listEvidence(id);
  assert.deepEqual(records.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(verifyChain(id), []);
  assert.equal(fs.existsSync(lockFile(id)), false);
});

test('commands that change one task at the same moment all take effect', async () => {
  const id = task(3);
  const results = await Promise.all(Array.from({ length: 6 }, (_, n) => cli('block', id, `reason ${n}`)));
  assert.deepEqual(results.map((r) => r.status), Array(6).fill(0), results.map((r) => r.out).join('\n'));
  const notes = loadState(id).history.map((h) => h.note).sort();
  assert.deepEqual(notes, ['reason 0', 'reason 1', 'reason 2', 'reason 3', 'reason 4', 'reason 5']);
  // A command that finds the task held for too long says who holds it and writes nothing.
  foreign(id, { pid: process.ppid, at: new Date().toISOString() });
  const before = fs.readFileSync(path.join(ROOT, 'issues', id, 'state.json'), 'utf8');
  assert.throws(() => withTask(id, () => saveState(loadState(id)), { wait: 150 }), /is changing demo-3 and did not finish/);
  assert.equal(fs.readFileSync(path.join(ROOT, 'issues', id, 'state.json'), 'utf8'), before);
  fs.rmSync(lockFile(id));
});

test('a reader that finds a task busy shows the moved step and leaves the writing to the holder', () => {
  const id = task(4, 'verify', { gatesSha: '0'.repeat(40) });
  foreign(id, { pid: process.ppid, at: new Date().toISOString() });
  const seen = sync(loadState(id));
  assert.equal(seen.stage, 'gates');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'issues', id, 'state.json'), 'utf8')).stage, 'verify');
  fs.rmSync(lockFile(id));
  // Free again, the move is written, once, from the stored state.
  assert.equal(sync(loadState(id)).stage, 'gates');
  const stored = loadState(id);
  assert.deepEqual([stored.stage, stored.gatesSha, stored.history.length], ['gates', null, 1]);
  assert.equal(sync(loadState(id)).history.length, 1);
});

test('settings changed by two processes at once keep both changes', async () => {
  write(path.join(tmp, 'edit.mjs'), `import { updateProject } from ${JSON.stringify(new URL('../lib/setup.mjs', import.meta.url).href)};\nupdateProject('demo', JSON.parse(process.argv[2]));\n`);
  const edit = (patch) => new Promise((resolve) => spawn(process.execPath, [path.join(tmp, 'edit.mjs'), JSON.stringify(patch)], { stdio: 'inherit' }).on('close', resolve));
  // One process is held up inside the lock while the other waits for it.
  const slow = withSettings(() => {
    const waiting = edit({ install: 'npm ci' });
    updateProject('demo', { agent: { allow: ['make check'] } });
    return waiting;
  });
  assert.equal(await slow, 0);
  assert.deepEqual([getRepo('demo').install, getRepo('demo').agent], ['npm ci', { allow: ['make check'] }]);
});

test('the board answers at once while GitHub is slow, and requests for the same answer share one call', async () => {
  const server = await startServer(0, { pairing: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    task(5);
    const started = Date.now();
    const slow = [fetch(`${base}/api/github/issues`), fetch(`${base}/api/github/issues`)];
    await new Promise((resolve) => setTimeout(resolve, 150));
    const timed = async (pathname) => { const t = Date.now(); const r = await fetch(`${base}${pathname}`); await r.text(); return [r.status, Date.now() - t]; };
    const [pingStatus, pingMs] = await timed('/api/ping');
    const [boardStatus, boardMs] = await timed('/board-data.js');
    assert.deepEqual([pingStatus, boardStatus], [200, 200]);
    assert.ok(pingMs < 500 && boardMs < 1500, `ping ${pingMs} ms, board ${boardMs} ms while GitHub was slow`);
    assert.ok(Date.now() - started < 1900, 'the fast requests finished before the slow one could have');
    const answers = await Promise.all(slow);
    assert.deepEqual(answers.map((r) => r.status), [200, 200]);
    // Two seconds each in a row would be four; one shared call is about two.
    assert.ok(Date.now() - started < 3600, `two requests for the same list took ${Date.now() - started} ms`);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('the GitHub issue list is kept across a restart and asked for again only on refresh or a changed filter', async () => {
  const { saveIssueFilter } = await import('../lib/github.mjs');
  const timed = async (base, pathname) => { const t = Date.now(); const r = await fetch(`${base}${pathname}`); return [await r.json(), Date.now() - t]; };
  // The test before this one loaded the list once; a board started afresh answers from what was kept.
  const server = await startServer(0, { pairing: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const kept = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', 'github-issues.json'), 'utf8'));
    const [first, firstMs] = await timed(base, '/api/github/issues');
    assert.ok(firstMs < 1000, `the kept list took ${firstMs} ms`);
    assert.equal(first.loadedAt, new Date(kept.at).toISOString());
    const [again, againMs] = await timed(base, '/api/github/issues');
    assert.ok(againMs < 1000 && again.loadedAt === first.loadedAt);
    // Refresh asks GitHub, and so does another filter; the stand-in takes two seconds to answer.
    const [refreshed, refreshMs] = await timed(base, '/api/github/issues?fresh=1');
    assert.ok(refreshMs >= 1900 && refreshed.loadedAt > first.loadedAt, `refresh took ${refreshMs} ms`);
    saveIssueFilter({ who: 'created', login: '', state: 'open', label: '' });
    const [other, otherMs] = await timed(base, '/api/github/issues');
    assert.ok(otherMs >= 1900 && other.filter.who === 'created', `a new filter took ${otherMs} ms`);
    assert.ok((await timed(base, '/api/github/issues'))[1] < 1000);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('a job reports its error to the caller, and a closed set of lanes starts nothing', async () => {
  const lanes = createLanes();
  await assert.rejects(lanes.run('local', 'nope'), /Unknown job "nope"/);
  await assert.rejects(lanes.run('side', 'board'), /Unknown lane "side"/);
  await assert.rejects(lanes.run('local', 'diff', { id: 'demo-999' }), /No factory issue "demo-999"/);
  assert.match(await lanes.run('local', 'board'), /^window\.__factoryData\(/);
  lanes.close();
  await assert.rejects(lanes.run('local', 'board'), /The board is stopping/);
});
