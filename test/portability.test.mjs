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
const bin = fileURLToPath(new URL('../bin/factory.mjs', import.meta.url));
const env = { ...process.env, FACTORY_ROOT: root, FACTORY_WORKSPACE: '', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
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
  const oddEnv = { ...env, FACTORY_ROOT: oddRoot };
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

test('shipped skills, agent and example settings are well formed', () => {
  const code = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const frontmatter = (file) => Object.fromEntries(/^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(path.join(code, file), 'utf8'))[1].split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
  for (const name of ['factory', 'factory-verify']) {
    const meta = frontmatter(`.agents/skills/${name}/SKILL.md`);
    assert.equal(meta.name, name);
    assert.ok(meta.description.length > 40);
  }
  const agent = frontmatter('.claude/agents/factory-verifier.md');
  assert.equal(agent.name, 'factory-verifier');
  assert.doesNotMatch(agent.tools, /Edit|Write/);
  const settings = JSON.parse(fs.readFileSync(path.join(code, 'docs/examples/claude-settings.example.json'), 'utf8'));
  assert.equal(settings.sandbox.enabled, true);
  assert.ok(settings.permissions.deny.includes('Bash(git push --force *)'));
});
