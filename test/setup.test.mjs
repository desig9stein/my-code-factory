// Covers setup, registry edits, the project and issue endpoints, and hook installation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/factory.mjs', import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-setup-')));
const ROOT = path.join(tmp, 'data');
const WS = path.join(tmp, 'ws');
const STUB = path.join(tmp, 'stub');
const GH_LOG = path.join(tmp, 'gh-args.json');
const GH_OUT = path.join(tmp, 'gh-out.json');

Object.assign(process.env, {
  FACTORY_ROOT: ROOT,
  FACTORY_WORKSPACE: '',
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
  PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
  GH_LOG,
  GH_OUT,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

const { addProject, removeProject, suggestProject, updateProject } = await import('../lib/setup.mjs');
const { checkIssueFilter, issueArgs, withTasks } = await import('../lib/github.mjs');
const { gateStatus } = await import('../lib/stages.mjs');
const { getRepo } = await import('../lib/registry.mjs');
const { runRecorded } = await import('../lib/evidence.mjs');
const { startServer } = await import('../lib/server.mjs');

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
const config = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// Creates a repo in the workspace with a pushed "main" and a second branch "next" on its origin.
function repo(name, files = {}) {
  const dir = path.join(WS, name);
  const remote = path.join(tmp, 'remotes', `${name}.git`);
  fs.mkdirSync(dir, { recursive: true });
  sh(tmp, `git init -q --bare -b main "${remote}"`);
  sh(dir, 'git init -q -b main');
  for (const [file, text] of Object.entries(files)) write(path.join(dir, file), text);
  write(path.join(dir, 'README.md'), name);
  sh(dir, `git add -A && git commit -q -m "chore(repo): seed" && git remote add origin "${remote}" && git push -q origin main main:next && git remote set-head origin main`);
  sh(dir, `git remote set-url origin git@github.com:acme/${name}.git`);
  return dir;
}
const pkg = (scripts) => JSON.stringify({ name: 'x', scripts });

let server;
let base;
let token;
const call = (pathname, body, headers = { 'x-factory-token': token }) => fetch(`${base}${pathname}`, body === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(body) });

before(async () => {
  fs.mkdirSync(WS, { recursive: true });
  // Records the arguments it was called with; "search" prints the canned result.
  write(path.join(STUB, 'gh'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 0.0.0 (stub)"; exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
node -e 'require("fs").writeFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(1)))' -- "$@"
if [ -n "$GH_FAIL" ]; then echo "$GH_FAIL" >&2; exit 4; fi
cat "$GH_OUT"
`);
  fs.chmodSync(path.join(STUB, 'gh'), 0o755);
  write(GH_OUT, '[]');
  repo('alpha', { 'package.json': pkg({ lint: 'true', test: 'true', build: 'true' }), 'package-lock.json': '{}' });
  repo('beta', { 'package.json': pkg({ verify: 'true', lint: 'true', test: 'true' }), 'yarn.lock': '' });
  repo('gamma');
  fs.mkdirSync(path.join(WS, 'notes'));
  server = undefined;
});
after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('setup without a terminal and without --yes registers nothing', () => {
  const r = cli('setup', '--workspace', WS);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /3 repositories found/);
  assert.match(r.out, /Nothing registered/);
  assert.deepEqual(registry().repos, {});
});

test('setup registers every GitHub repo in the workspace and skips one that is already registered', () => {
  addProject('alpha', path.join(WS, 'alpha'), { verify: 'npm run lint' });
  const r = cli('setup', '--workspace', WS, '--yes');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /2 repositories found/);
  assert.deepEqual(Object.keys(registry().repos).sort(), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(registry().repos.alpha.gates, [{ name: 'verify', cmd: 'npm run lint' }]);
  assert.equal(registry().repos.beta.remote, 'acme/beta');
  assert.match(cli('setup', '--workspace', WS, '--yes').out, /No unregistered GitHub repositories/);
});

test('suggests "npm ci" for a package-lock.json and a frozen yarn install for a yarn.lock', () => {
  assert.equal(suggestProject(path.join(WS, 'alpha')).install, 'npm ci');
  assert.equal(suggestProject(path.join(WS, 'beta')).install, 'yarn install --frozen-lockfile');
  assert.equal(suggestProject(path.join(WS, 'gamma')).install, '');
});

test('suggests verify over lint and test, and no gate when there are no scripts', () => {
  assert.deepEqual(suggestProject(path.join(WS, 'beta')).gates, [{ name: 'verify', cmd: 'npm run verify' }]);
  assert.deepEqual(suggestProject(path.join(WS, 'alpha')).gates, [{ name: 'verify', cmd: 'npm run lint && npm test' }]);
  assert.deepEqual(suggestProject(path.join(WS, 'gamma')).gates, []);
});

test('update changes the base branch and keeps the other stored fields', () => {
  const stored = registry();
  stored.repos.beta.prBody = { requiredSections: ['Summary'] };
  write(path.join(ROOT, 'repos.json'), JSON.stringify(stored));
  updateProject('beta', { baseBranch: 'next' });
  const beta = registry().repos.beta;
  assert.equal(beta.baseBranch, 'next');
  assert.deepEqual(beta.prBody, { requiredSections: ['Summary'] });
  assert.deepEqual(beta.gates, [{ name: 'verify', cmd: 'npm run verify' }]);
});

test('a base branch that differs from origin/HEAD is not reported as drift by doctor', () => {
  assert.equal(registry().repos.beta.allowBaseMismatch, true);
  assert.doesNotMatch(cli('doctor').out, /beta: baseBranch/);
  updateProject('beta', { baseBranch: 'main' });
  assert.equal('allowBaseMismatch' in registry().repos.beta, false);
});

test('update rejects a base branch that origin does not have, with the fetch hint', () => {
  assert.throws(() => updateProject('beta', { baseBranch: 'nope' }), /origin\/nope does not exist.*git fetch origin nope/);
  assert.throws(() => updateProject('beta', { baseBranch: '--upload-pack=x' }), /is not a branch name/);
  assert.equal(registry().repos.beta.baseBranch, 'main');
});

test('update rejects a field it does not edit', () => {
  assert.throws(() => updateProject('beta', { remote: 'evil/repo' }), /"remote" cannot be changed here\. Editable fields: baseBranch, install, gates/);
});

test('update rejects a duplicate gate name', () => {
  assert.throws(() => updateProject('beta', { gates: [{ name: 'lint', cmd: 'a' }, { name: 'lint', cmd: 'b' }] }), /"lint" is used twice/);
});

test('update rejects a gate name the CLI reserves', () => {
  assert.throws(() => updateProject('beta', { gates: [{ name: 'install', cmd: 'npm ci' }] }), /"install" is reserved/);
});

test('update rejects a multi-line command and an empty one', () => {
  assert.throws(() => updateProject('beta', { gates: [{ name: 'lint', cmd: 'a\nb' }] }), /must be one line/);
  assert.throws(() => updateProject('beta', { gates: [{ name: 'lint', cmd: '  ' }] }), /Gate "lint" has no command/);
  assert.throws(() => updateProject('beta', { install: 'a\nb' }), /The install command must be one line/);
});

test('update rejects a gate cwd outside the project', () => {
  assert.throws(() => updateProject('beta', { gates: [{ name: 'lint', cmd: 'a', cwd: '../alpha' }] }), /must be a folder inside the project/);
});

test('a gate pass recorded with the old command is stale after the command changes', () => {
  const dir = path.join(WS, 'gamma');
  const state = { id: 'gamma-1', repo: 'gamma', worktree: dir };
  updateProject('gamma', { gates: [{ name: 'verify', cmd: 'true' }] });
  runRecorded(state, { name: 'verify', kind: 'gate', cmd: 'true', cwd: dir });
  assert.equal(gateStatus(state, getRepo('gamma'))[0].status, 'passed');
  updateProject('gamma', { gates: [{ name: 'verify', cmd: 'true && true' }] });
  assert.equal(gateStatus(state, getRepo('gamma'))[0].status, 'stale');
});

test('remove is refused while a task of the project is in flight', () => {
  const dir = path.join(WS, 'gamma');
  write(path.join(ROOT, 'issues', 'gamma-1', 'state.json'), JSON.stringify({ id: 'gamma-1', kind: 'issue', repo: 'gamma', issue: 1, title: 't', stage: 'implement', worktree: dir, branch: 'main', base: 'main', history: [] }));
  assert.throws(() => removeProject('gamma'), /gamma has tasks in flight: gamma-1\. Archive them first/);
  assert.ok(registry().repos.gamma);
});

test('the server refuses project update, add and remove without the token', async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
  token = /__factoryToken="([0-9a-f]{32})"/.exec(await (await fetch(`${base}/`)).text())[1];
  for (const route of ['update', 'add', 'remove']) {
    assert.equal((await call(`/api/project/${route}`, { key: 'alpha' }, {})).status, 403, route);
  }
  assert.equal((await call('/api/github/filter', { who: 'anyone' }, {})).status, 403);
  assert.ok(registry().repos.alpha);
});

test('the server updates a project and reports a rejected value', async () => {
  const ok = await call('/api/project/update', { key: 'alpha', install: 'npm ci --ignore-scripts', gates: [{ name: 'lint', cmd: 'npm run lint' }, { name: 'test', cmd: 'npm test' }] });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(registry().repos.alpha.install, 'npm ci --ignore-scripts');
  assert.equal(registry().repos.alpha.gates.length, 2);
  const bad = await call('/api/project/update', { key: 'alpha', baseBranch: 'nope' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /origin\/nope does not exist/);
});

test('the server registers a workspace folder, and refuses a folder that is not a repository root', async () => {
  const delta = repo('delta', { 'package.json': pkg({ test: 'true' }) });
  const setup = await (await call('/api/setup')).json();
  assert.deepEqual(setup.candidates.map((c) => c.key), ['delta']);
  assert.equal(setup.hooksInstalled, false);
  const outside = await call('/api/project/add', { key: 'out', dir: tmp, baseBranch: 'main', install: '', gates: [] });
  assert.equal(outside.status, 400);
  assert.match((await outside.json()).error, /is not a Git repository\. Clone the project first/);
  const added = await call('/api/project/add', { key: 'delta', dir: delta, baseBranch: 'main', install: '', gates: [{ name: 'test', cmd: 'npm test' }] });
  assert.equal(added.status, 200, await added.clone().text());
  assert.deepEqual(registry().repos.delta, { dir: 'delta', remote: 'acme/delta', baseBranch: 'main', install: '', gates: [{ name: 'test', cmd: 'npm test' }] });
  assert.equal((await call('/api/project/remove', { key: 'delta' })).status, 200);
  assert.equal(registry().repos.delta, undefined);
});

test('a repository outside the workspace is found by its folder and registered with its full path', async () => {
  const dir = path.join(tmp, 'elsewhere', 'omega');
  const remote = path.join(tmp, 'remotes', 'omega.git');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  sh(tmp, `git init -q --bare -b main "${remote}"`);
  write(path.join(dir, 'package.json'), pkg({ lint: 'true' }));
  sh(dir, `git init -q -b main && git add -A && git commit -q -m "chore(repo): seed" && git remote add origin "${remote}" && git push -q origin main && git remote set-head origin main && git remote set-url origin git@github.com:acme/omega.git`);
  const locate = (typed, headers) => call('/api/project/locate', { path: typed }, headers);
  assert.equal((await locate(dir, {})).status, 403);
  const found = await (await locate(dir)).json();
  assert.deepEqual([found.key, found.remote, found.baseBranch, found.outside, found.gates[0].cmd], ['omega', 'acme/omega', 'main', true, 'npm run lint']);
  assert.match((await (await locate(path.join(dir, 'src'))).json()).error, /is a folder inside a repository\. Enter the repository root: /);
  assert.match((await (await locate(path.join(tmp, 'nowhere'))).json()).error, /is not a folder on this machine/);
  assert.match((await (await locate('')).json()).error, /Enter the folder of a Git repository/);
  assert.match((await (await locate(path.join(WS, 'alpha'))).json()).error, /is already registered as "alpha"/);
  assert.equal((await call('/api/project/add', { key: found.key, dir: found.dir, baseBranch: found.baseBranch, install: '', gates: found.gates })).status, 200);
  assert.equal(registry().repos.omega.dir, fs.realpathSync(dir));
  assert.match((await (await fetch(`${base}/board-data.js`)).text()), /"workspace":"/);
  assert.equal((await call('/api/project/remove', { key: 'omega' })).status, 200);
});

test('the board starts a task itself, and the task carries a prompt and a folder for the agent', async () => {
  const start = (body, headers) => call('/api/task/start', body, headers);
  assert.equal((await start({ project: 'gamma', number: 2, kind: 'new' }, {})).status, 403);
  assert.match((await (await start({ project: 'nope', number: 2, kind: 'new' })).json()).error, /Unknown project "nope"/);
  assert.match((await (await start({ project: 'gamma', number: '2; rm -rf', kind: 'new' })).json()).error, /must be a whole number above 0/);
  assert.match((await (await start({ project: 'gamma', number: 2, kind: 'delete' })).json()).error, /kind must be "new" or "review"/);
  write(GH_OUT, JSON.stringify({ number: 2, title: 'Add a thing', body: 'Please.', labels: [], url: 'https://github.com/acme/gamma/issues/2' }));
  const started = await start({ project: 'gamma', number: 2, kind: 'new' });
  assert.equal(started.status, 200, await started.clone().text());
  assert.equal((await started.json()).id, 'gamma-2');
  const data = await (await fetch(`${base}/board-data.js`)).text();
  const task = JSON.parse(data.slice(data.indexOf('(') + 1, data.lastIndexOf(')'))).issues.find((i) => i.id === 'gamma-2');
  assert.equal(task.stage, 'intake');
  assert.equal(task.worktree, path.join(ROOT, 'worktrees', 'gamma-2'));
  assert.match(task.prompt, /^Work on the Codeignite task gamma-2 with the factory skill\. Start by running: node '.*bin\/factory\.mjs' next gamma-2$/);
  assert.match((await (await start({ project: 'gamma', number: 2, kind: 'new' })).json()).error, /gamma-2 already exists at stage "intake"/);
});

test('the issues query defaults to issues assigned to you in every registered remote', async () => {
  write(GH_OUT, JSON.stringify([
    { number: 1, title: 'In flight', url: 'https://github.com/acme/gamma/issues/1', repository: { nameWithOwner: 'acme/gamma' }, labels: [{ name: 'bug' }], assignees: [{ login: 'me' }], updatedAt: '2026-01-02T00:00:00Z' },
    { number: 9, title: 'Open', url: 'https://github.com/acme/alpha/issues/9', repository: { nameWithOwner: 'acme/alpha' }, labels: [], assignees: [], updatedAt: '2026-01-01T00:00:00Z' },
    { number: 3, title: 'Elsewhere', url: 'https://github.com/other/repo/issues/3', repository: { nameWithOwner: 'other/repo' }, labels: [], assignees: [], updatedAt: '2026-01-01T00:00:00Z' },
  ]));
  const response = await call('/api/github/issues');
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  const args = JSON.parse(fs.readFileSync(GH_LOG, 'utf8'));
  assert.deepEqual(args.slice(0, 6), ['search', 'issues', '--assignee', '@me', '--state', 'open']);
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '--repo').sort(), ['acme/alpha', 'acme/beta', 'acme/gamma']);
  assert.deepEqual(result.issues.map((i) => `${i.project}#${i.number}`), ['gamma#1', 'alpha#9']);
  assert.deepEqual(result.issues[0].labels, ['bug']);
});

test('an issue that is already a task carries its task id and stage', async () => {
  const { issues } = await (await call('/api/github/issues')).json();
  assert.deepEqual(issues[0].task, { id: 'gamma-1', stage: 'implement' });
  assert.equal(issues[1].task, null);
  assert.deepEqual(withTasks([{ project: 'alpha', number: 1 }])[0].task, null);
});

test('a saved filter of "anyone" drops the assignee, and a user filter passes that login', async () => {
  const saved = await call('/api/github/filter', { who: 'user', login: '@octocat', state: 'closed', label: 'bug' });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual(config().issues, { who: 'user', login: 'octocat', state: 'closed', label: 'bug' });
  assert.equal(config().workspace, WS);
  await call('/api/github/issues');
  assert.deepEqual(JSON.parse(fs.readFileSync(GH_LOG, 'utf8')).slice(0, 8), ['search', 'issues', '--assignee', 'octocat', '--state', 'closed', '--label', 'bug']);
  assert.deepEqual(issueArgs(checkIssueFilter({ who: 'anyone' }), ['a/b']).slice(0, 6), ['search', 'issues', '--state', 'open', '--repo', 'a/b']);
  assert.deepEqual(issueArgs(checkIssueFilter({ who: 'created' }), []).slice(2, 4), ['--author', '@me']);
});

test('the filter rejects an unknown mode and a login with shell characters', async () => {
  const mode = await call('/api/github/filter', { who: 'everyone' });
  assert.equal(mode.status, 400);
  assert.match((await mode.json()).error, /"everyone" is not a valid "who"\. Valid values: assigned, created, mentioned, involved, user, anyone/);
  assert.throws(() => checkIssueFilter({ who: 'user', login: 'a; rm -rf /' }), /is not a GitHub login/);
  assert.throws(() => checkIssueFilter({ state: 'merged' }), /Valid values: open, closed/);
  assert.throws(() => checkIssueFilter({ repo: 'x' }), /"repo" is not an issue filter field/);
  assert.equal(config().issues.who, 'user');
});

test('a failing gh returns the login hint, not an empty list', async () => {
  process.env.GH_FAIL = 'HTTP 401: Bad credentials';
  try {
    const response = await call('/api/github/issues?fresh=1');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /GitHub search failed: HTTP 401: Bad credentials\..*gh auth login/);
  } finally {
    delete process.env.GH_FAIL;
  }
});

test('hooks install keeps the other hooks, writes a backup, and is a no-op the second time', () => {
  const file = path.join(tmp, 'claude', 'settings.json');
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
  const old = { matcher: '', hooks: [{ type: 'command', command: "node '/old/factory/bin/guard.mjs' pre" }] };
  write(file, JSON.stringify({ model: 'x', hooks: { PreToolUse: [other, old], Stop: [other] } }));
  const first = cli('hooks', '--install');
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /Hooks merged into/);
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.model, 'x');
  assert.deepEqual(settings.hooks.Stop, [other]);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.deepEqual(settings.hooks.PreToolUse[0], other);
  assert.match(settings.hooks.PreToolUse[1].hooks[0].command, /bin\/guard\.mjs' pre$/);
  assert.doesNotMatch(JSON.stringify(settings), /old\/factory/);
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.match(fs.readFileSync(`${file}.bak`, 'utf8'), /old\/factory/);
  const second = cli('hooks', '--install');
  assert.match(second.out, /already current/);
  assert.match(cli('hooks').out, /"PreToolUse"/);
});
