// Covers what a project runs for each task: setup when it is created, teardown when it is archived,
// and the port and folder each task's commands are told.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/codeignite.mjs', import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeignite-setup-')));
const ROOT = path.join(tmp, 'data');
const WS = path.join(tmp, 'ws');
const STUB = path.join(tmp, 'stub');
const ISSUE = path.join(tmp, 'issue.json');
delete process.env.CODEIGNITE_PORT;
delete process.env.NODE_TEST_CONTEXT;
delete process.env.CLAUDECODE;
Object.assign(process.env, { CODEIGNITE_ROOT: ROOT, CODEIGNITE_WORKSPACE: WS, PATH: `${STUB}${path.delimiter}${process.env.PATH}`, GH_ISSUE: ISSUE, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });

const { freePort, taskEnv } = await import('../lib/taskenv.mjs');
const { updateProject } = await import('../lib/setup.mjs');
const { getRepo } = await import('../lib/registry.mjs');
const { loadState } = await import('../lib/state.mjs');
const { listEvidence } = await import('../lib/evidence.mjs');
const { exportConfig, planImport } = await import('../lib/share.mjs');
const { settingUp } = await import('../lib/tasksetup.mjs');
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
const cli = (...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: tmp });
  return { status: r.status, out: r.stdout + r.stderr };
};

// A project with an origin to branch from, and a stand-in for the GitHub CLI that answers with one issue.
const REPO = path.join(WS, 'demo');
const ORIGIN = path.join(tmp, 'origin.git');
fs.mkdirSync(REPO, { recursive: true });
sh(tmp, `git init -q --bare -b main "${ORIGIN}"`);
sh(REPO, `git init -q -b main && printf '.task/\\n' > .gitignore && echo one > a.txt && git add -A && git commit -q -m "feat: one" && git remote add origin "${ORIGIN}" && git push -q -u origin main && git remote set-head origin main`);
write(path.join(STUB, 'gh'), '#!/bin/sh\ncat "$GH_ISSUE"\n');
fs.chmodSync(path.join(STUB, 'gh'), 0o755);
write(path.join(ROOT, 'config.json'), JSON.stringify({ workspace: WS }));
write(path.join(ROOT, 'repos.json'), JSON.stringify({ defaults: { branchPattern: 'codeignite/{type}-{n}-{slug}' }, repos: { demo: { dir: 'demo', remote: 'acme/demo', baseBranch: 'main', install: '', gates: [{ name: 'test', cmd: 'true' }] } } }));
const issue = (number) => write(ISSUE, JSON.stringify({ number, title: `Task ${number}`, body: 'Do it.', labels: [], url: `https://github.com/acme/demo/issues/${number}`, state: 'OPEN', comments: [] }));
const seen = (id) => fs.readFileSync(path.join(ROOT, 'worktrees', id, '.task', 'seen'), 'utf8').trim();

test('a project takes a setup and a teardown command, checked like its other commands', () => {
  assert.throws(() => updateProject('demo', { setup: 'one\ntwo' }), /The setup command/);
  assert.throws(() => updateProject('demo', { gates: [{ name: 'setup', cmd: 'true' }] }), /Gate name "setup" is reserved/);
  updateProject('demo', { setup: 'mkdir -p .task && echo "$CODEIGNITE_TASK_ID $CODEIGNITE_TASK_PORT $CODEIGNITE_TASK_DIR" > .task/seen', teardown: 'echo "$CODEIGNITE_TASK_ID gone" >> "$TEARDOWN_LOG"' });
  assert.match(getRepo('demo').setup, /^mkdir -p \.task/);
  // Both are part of what a team shares, and are checked again when a shared file is applied.
  assert.match(exportConfig().projects.demo.teardown, /gone/);
  assert.throws(() => planImport({ codeigniteConfig: 1, projects: { demo: { remote: 'acme/demo', baseBranch: 'main', setup: 'a\nb' } } }), /The setup command of "demo"/);
});

test('a new task gets a port of its own and its setup runs in its folder', () => {
  issue(1);
  const first = cli('new', 'demo#1');
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /port\s+41000\n/);
  assert.match(first.out, /Setting up: mkdir -p \.task .*\nSetup finished\./);
  issue(2);
  assert.match(cli('new', 'demo#2').out, /port\s+41001\n/);
  // Each setup was told its own task, port and folder.
  assert.equal(seen('demo-1'), `demo-1 41000 ${path.join(ROOT, 'worktrees', 'demo-1')}`);
  assert.equal(seen('demo-2'), `demo-2 41001 ${path.join(ROOT, 'worktrees', 'demo-2')}`);
  assert.deepEqual([loadState('demo-1').port, loadState('demo-2').port], [41000, 41001]);
  assert.deepEqual(taskEnv(loadState('demo-2')), { CODEIGNITE_TASK_ID: 'demo-2', CODEIGNITE_TASK_DIR: path.join(ROOT, 'worktrees', 'demo-2'), CODEIGNITE_TASK_PORT: '41001' });
  // The run is on record with its log, and the agent's brief names the port.
  assert.deepEqual(listEvidence('demo-1').map((r) => [r.name, r.kind, r.ok]), [['setup', 'setup', true]]);
  assert.match(cli('next', 'demo-1').out, /Port 41000 is reserved for this task \(also in \$CODEIGNITE_TASK_PORT\)/);
  // The lowest port nobody holds is the next one; a task without a port has no port variable.
  assert.equal(freePort(), 41002);
  assert.equal(freePort([{ port: 41001 }, { port: 41000 }, { port: 41003 }, {}]), 41002);
  assert.deepEqual(Object.keys(taskEnv({ id: 'x-1', worktree: '/w' })), ['CODEIGNITE_TASK_ID', 'CODEIGNITE_TASK_DIR']);
});

test('a setup that fails leaves the task in place, says so, and can be run again', () => {
  updateProject('demo', { setup: 'echo "no database" && exit 3' });
  issue(3);
  const made = cli('new', 'demo#3');
  assert.equal(made.status, 0, made.out);
  assert.match(made.out, /Created demo-3/);
  assert.match(made.out, /Setup FAILED \(exit 3\)\. The task was created\. Fix the cause, then run: codeignite run demo-3 setup/);
  assert.match(loadState('demo-3').history.at(-1).note, /Setup failed \(exit 3\)/);
  assert.equal(listEvidence('demo-3')[0].ok, false);
  updateProject('demo', { setup: 'mkdir -p .task && echo ready > .task/seen' });
  assert.equal(cli('run', 'demo-3', 'setup').status, 0);
  assert.equal(seen('demo-3'), 'ready');
  // A project without the command has nothing to run again.
  updateProject('demo', { setup: '' });
  assert.equal(getRepo('demo').setup, undefined);
  assert.match(cli('run', 'demo-3', 'setup').out, /demo has no setup command in the registry/);
});

test('archiving runs the teardown first, and a teardown that fails does not keep the task', () => {
  const log = path.join(tmp, 'teardown.log');
  process.env.TEARDOWN_LOG = log;
  const gone = cli('archive', 'demo-1');
  assert.equal(gone.status, 0, gone.out);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'demo-1 gone');
  assert.equal(fs.existsSync(path.join(ROOT, 'worktrees', 'demo-1')), false);
  // The port of an archived task is free again.
  assert.equal(freePort(), 41000);
  updateProject('demo', { teardown: 'touch left-behind.txt && exit 7' });
  const failed = cli('archive', 'demo-2');
  assert.equal(failed.status, 0, failed.out);
  assert.equal(fs.existsSync(path.join(ROOT, 'worktrees', 'demo-2')), false);
  const notes = JSON.parse(fs.readFileSync(path.join(ROOT, 'issues', 'demo-2', 'state.json'), 'utf8')).history.map((h) => h.note);
  assert.ok(notes.some((note) => /Teardown failed \(exit 7\)/.test(note)));
});

test('files a setup leaves that Git does not ignore are named at once', () => {
  updateProject('demo', { setup: 'echo secret > local.env && mkdir -p .task && echo ok > .task/seen', teardown: '' });
  issue(4);
  const made = cli('new', 'demo#4');
  assert.equal(made.status, 0, made.out);
  assert.match(made.out, /Setup finished\.\nSetup left files Git does not ignore: local\.env\.\nAdd them to \.gitignore; until then the checks refuse the folder as changed\./);
  assert.match(loadState('demo-4').history.at(-1).note, /Setup left files Git does not ignore: local\.env\./);
  // What Git ignores is not named.
  assert.ok(!/does not ignore: [^\n]*\.task/.test(made.out));
});

test('a task made before ports existed gets one the first time it is used', () => {
  const file = path.join(ROOT, 'issues', 'demo-4', 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete state.port;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(loadState('demo-4').port, undefined);
  assert.match(cli('next', 'demo-4').out, /Port 4100\d is reserved for this task/);
  assert.ok(Number.isInteger(loadState('demo-4').port));
  // It keeps that port from then on.
  const kept = loadState('demo-4').port;
  cli('next', 'demo-4');
  assert.equal(loadState('demo-4').port, kept);
});

test('the board creates a task at once and runs its setup beside it', async () => {
  updateProject('demo', { setup: 'sleep 2 && mkdir -p .task && echo late > .task/seen' });
  const server = await startServer(0, { pairing: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = /__factoryToken="([0-9a-f]+)"/.exec(await (await fetch(base)).text())[1];
  const call = (pathname, body) => fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Factory-Token': token }, body: JSON.stringify(body) });
  const board = async () => { const text = await (await fetch(`${base}/board-data.js`)).text(); assert.match(text, /^window\.__factoryData\(/, text.slice(0, 400)); return JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))); };
  const wait = async (check, what) => { for (let n = 0; n < 200; n++) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(`Timed out waiting for ${what}.`); };
  try {
    issue(5);
    const started = Date.now();
    const made = await call('/api/task/start', { project: 'demo', number: 5, kind: 'new' });
    assert.equal(made.status, 200, await made.clone().text());
    // The answer does not wait for the two seconds the setup takes.
    assert.ok(Date.now() - started < 1900, `creating the task took ${Date.now() - started} ms`);
    await wait(() => settingUp('demo-5'), 'the setup to start');
    assert.equal((await board()).issues.find((i) => i.id === 'demo-5').settingUp, true);
    // No agent starts in a folder that is still being prepared.
    assert.match((await (await call('/api/agent/run', { id: 'demo-5' })).json()).error, /The setup command of demo-5 is still running/);
    await wait(() => !settingUp('demo-5') && listEvidence('demo-5').length === 1, 'the setup to finish');
    assert.equal(seen('demo-5'), 'late');
    assert.equal((await board()).issues.find((i) => i.id === 'demo-5').settingUp, false);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

