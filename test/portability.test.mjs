import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-portable-'));
const root = path.join(tmp, 'private data');
const ws = path.join(tmp, 'projects with spaces');
fs.mkdirSync(ws);
const bin = fileURLToPath(new URL('../bin/codeignite.mjs', import.meta.url));
const env = { ...process.env, CODEIGNITE_ROOT: root, CODEIGNITE_WORKSPACE: '', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
const git = (...args) => { const r = spawnSync('git', args, { cwd: ws, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('initialization and project registration are portable and preserve existing configuration', () => {
  assert.equal(cli('init', '--workspace', ws).status, 0);
  git('init', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:example/app.git');
  git('commit', '--allow-empty', '-m', 'chore(repo): initialize');
  const result = cli('add', 'app', ws, '--verify', 'npm run verify');
  assert.equal(result.status, 0, result.stderr);
  const configFile = path.join(root, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  assert.equal(cli('init', '--workspace', tmp).status, 0);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'repos.json')));
  assert.deepEqual(registry.repos.app, { dir: '.', remote: 'example/app', baseBranch: 'main', install: '', gates: [{ name: 'verify', cmd: 'npm run verify' }] });
  assert.equal(cli('add', 'app', ws).status, 1);
  assert.equal(cli('add', '../escape', ws).status, 1);
});

test('state identifiers cannot traverse outside runtime storage', async () => {
  const { issueDir, within } = await import('../lib/paths.mjs');
  for (const id of ['../escape', '../../secret', '/tmp/other', '.', '..', 'foo/bar']) assert.throws(() => issueDir(id));
  assert.equal(within('/tmp/root/../other', '/tmp/root'), false);
  assert.equal(within('/tmp/root/..file', '/tmp/root'), true);
});

test('generated hook commands preserve paths containing spaces and shell metacharacters', () => {
  const oddRoot = path.join(tmp, "user's $(not-a-command) data");
  const oddEnv = { ...env, CODEIGNITE_ROOT: oddRoot };
  const init = spawnSync(process.execPath, [bin, 'init', '--workspace', ws], { env: oddEnv, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const result = spawnSync(process.execPath, [bin, 'hooks'], { env: oddEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(result.stdout);
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  const run = spawnSync('sh', ['-c', command], { input: '{}', encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
});

test('the example settings enable the sandbox and deny a forced push', () => {
  const code = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const settings = JSON.parse(fs.readFileSync(path.join(code, 'docs/examples/claude-settings.example.json'), 'utf8'));
  assert.equal(settings.sandbox.enabled, true);
  assert.ok(settings.permissions.deny.includes('Bash(git push --force *)'));
});

test('the project graph orders what a change reaches, reports bad links and suggests links from manifests', async () => {
  const { buildGraph, coverage, detectLinks, reach } = await import('../lib/graph.mjs');
  const repos = {
    theming: { dir: 'g/theming', remote: 'acme/ui-theming', description: 'Themes' },
    angular: { dir: 'g/angular', remote: 'acme/ui-angular', dependsOn: ['theming'] },
    wc: { dir: 'g/wc', remote: 'acme/ui-webcomponents', dependsOn: [{ project: 'theming', label: 'uses styles' }] },
    react: { dir: 'g/react', remote: 'acme/ui-react', dependsOn: [{ project: 'wc', label: 'wraps components' }] },
    blazor: { dir: 'g/blazor', remote: 'acme/ui-blazor', dependsOn: ['wc'] },
  };
  const graph = buildGraph({ repos });
  assert.deepEqual(graph.problems, []);
  assert.deepEqual(graph.nodes.map((n) => [n.key, n.layer]), [['theming', 0], ['angular', 1], ['wc', 1], ['react', 2], ['blazor', 2]]);
  assert.deepEqual(graph.nodes.find((n) => n.key === 'wc').usedBy, ['react', 'blazor']);
  assert.deepEqual(reach(graph, 'theming'), [{ key: 'angular', depth: 1, via: 'theming' }, { key: 'wc', depth: 1, via: 'theming' }, { key: 'blazor', depth: 2, via: 'wc' }, { key: 'react', depth: 2, via: 'wc' }]);
  assert.deepEqual(reach(graph, 'react'), []);
  const covered = coverage(graph, 'theming', '- angular: visual check.\n- ui-webcomponents: regenerate CSS.\n');
  assert.deepEqual(covered.map((r) => [r.key, r.mentioned]), [['angular', true], ['wc', true], ['blazor', false], ['react', false]]);
  // A project reached along many paths is listed once, at its longest distance, and the work stays small.
  const wide = { repos: { root: {} } };
  for (let i = 0; i < 60; i++) wide.repos[`n${i}`] = { dependsOn: i ? [`n${i - 1}`, i > 5 ? `n${i - 5}` : 'root'] : ['root'] };
  const started = Date.now();
  const far = reach(buildGraph(wide), 'root');
  assert.equal(far.length, 60);
  assert.deepEqual(far.at(-1), { key: 'n59', depth: 60, via: 'n58' });
  assert.ok(Date.now() - started < 1000);
  // An unknown project and a cycle are reported, and the offending links are left out.
  const broken = buildGraph({ repos: { a: { dependsOn: ['b', 'ghost'] }, b: { dependsOn: ['a'] } } });
  assert.match(broken.problems.join('\n'), /"ghost", which is not a registered project/);
  assert.match(broken.problems.join('\n'), /Cycle: /);
  assert.equal(broken.nodes.reduce((n, x) => n + x.dependsOn.length, 0), 1);
  // Entries of the wrong shape are reported once each and never crash the graph.
  const junk = buildGraph({ repos: { a: { dependsOn: 'not-a-list', description: { nested: true } }, b: { dependsOn: [null, 42, { project: 'a', label: '<b>x</b>' }, { project: 'a' }, 'b'] } } });
  assert.equal(junk.nodes.find((n) => n.key === 'a').description, '');
  assert.deepEqual(junk.nodes.find((n) => n.key === 'b').dependsOn, [{ key: 'a', label: '<b>x</b>' }]);
  assert.equal(junk.problems.filter((p) => /neither a project key/.test(p)).length, 2);
  assert.equal(junk.problems.filter((p) => /cannot depend on itself/.test(p)).length, 1);
  // Manifests: react lists a package that wc publishes from a nested folder.
  const write = (file, json) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(json)); };
  process.env.CODEIGNITE_WORKSPACE = ws;
  try {
    write(path.join(ws, 'g/wc/packages/core/package.json'), { name: '@acme/wc', version: '5.2.0' });
    write(path.join(ws, 'g/react/package.json'), { name: '@acme/react', peerDependencies: { '@acme/wc': '^5.1.0' }, dependencies: { lodash: '^4' } });
    assert.deepEqual(detectLinks({ repos }), [{ from: 'react', to: 'wc', package: '@acme/wc', range: '^5.1.0', version: '5.2.0' }]);
  } finally {
    delete process.env.CODEIGNITE_WORKSPACE;
  }
});

test('graph and doctor print relationships, and add refuses an unregistered dependency', () => {
  const project = (name) => { const dir = path.join(ws, name); fs.mkdirSync(dir); git('init', '-q', '-b', 'main', dir); return dir; };
  const base = project('lib-base'), app = project('lib-app');
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: '@x/base', version: '2.0.0' }));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: '@x/app', dependencies: { '@x/base': '^1.9.0' } }));
  assert.match(cli('add', 'app2', app, '--remote', 'x/app', '--base', 'main', '--depends-on', 'base2').stderr, /not registered/);
  assert.equal(cli('add', 'base2', base, '--remote', 'x/base', '--base', 'main', '--description', 'Shared base').status, 0);
  assert.equal(cli('add', 'app2', app, '--remote', 'x/app', '--base', 'main').status, 0);
  assert.match(cli('doctor').stdout, /app2 lists @x\/base \(\^1\.9\.0\), which base2 publishes/);
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'repos.json'), 'utf8'));
  registry.repos.app2.dependsOn = [{ project: 'base2', label: 'uses helpers' }];
  fs.writeFileSync(path.join(root, 'repos.json'), JSON.stringify(registry));
  assert.doesNotMatch(cli('doctor').stdout, /Suggested relationships/);
  assert.match(cli('graph').stdout, /base2 - Shared base\n\s+└─ app2 \(uses helpers\)/);
  assert.match(cli('graph', 'base2').stdout, /a change here reaches 1 project, in this order:\n\s+1\. app2/);
  assert.equal(JSON.parse(cli('graph', '--json').stdout).nodes.find((n) => n.key === 'base2').reach[0].key, 'app2');
  // A project with two dependencies appears under both, and its own users are printed once.
  for (let i = 0; i < 30; i++) registry.repos[`m${i}`] = { dir: 'lib-app', remote: `x/m${i}`, baseBranch: 'main', dependsOn: i ? [`m${i - 1}`, i > 1 ? `m${i - 2}` : 'app2'] : ['app2'] };
  fs.writeFileSync(path.join(root, 'repos.json'), JSON.stringify(registry));
  const tree = cli('graph').stdout;
  assert.ok(tree.split('\n').length < 100, `tree has ${tree.split('\n').length} lines`);
  assert.match(tree, /its users are listed above/);
});
