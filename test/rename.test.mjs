// Covers the move from the name "factory" to "codeignite": the old names keep working, and "codeignite migrate"
// carries an existing install over.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/', import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeignite-rename-')));
const HOME = path.join(tmp, 'home');
const OLD = path.join(HOME, '.code-factory');
const NEW = path.join(HOME, '.codeignite');
const WS = path.join(HOME, 'projects');
const CLAUDE = path.join(HOME, '.claude');
for (const name of ['CODEIGNITE_ROOT', 'CODEIGNITE_WORKSPACE', 'CODEIGNITE_PORT', 'FACTORY_ROOT', 'FACTORY_WORKSPACE', 'FACTORY_PORT', 'CLAUDECODE', 'NODE_TEST_CONTEXT']) delete process.env[name];
Object.assign(process.env, { HOME, CLAUDE_CONFIG_DIR: CLAUDE, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });

const { factoryRoot, setting } = await import('../lib/paths.mjs');
const { boardPort } = await import('../lib/port.mjs');
const { decide } = await import('../lib/guard.mjs');
const { planImport } = await import('../lib/share.mjs');
const { resolveWorkflow } = await import('../lib/workflow.mjs');
const { commandLinked, commandText } = await import('../lib/cli.mjs');
const { migrate, planMigration } = await import('../lib/migrate.mjs');

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const sh = (cwd, cmd) => {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};
const cli = (file, args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(BIN, file), ...args], { encoding: 'utf8', cwd: tmp, env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
};
const bash = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: tmp });

// An install as the version before the rename left it: the old folder, a workspace written relative to it,
// a task with a real worktree inside it, and hooks, a skill and an agent under the old names.
const REPO = path.join(WS, 'demo');
const WORKTREE = path.join(OLD, 'worktrees', 'demo-1');
fs.mkdirSync(REPO, { recursive: true });
sh(REPO, 'git init -q -b main && echo one > a.txt && git add -A && git commit -q -m "feat: one"');
fs.mkdirSync(path.join(OLD, 'worktrees'), { recursive: true });
sh(REPO, `git worktree add -q -b fix "${WORKTREE}"`);
write(path.join(OLD, 'config.json'), JSON.stringify({ version: 1, workspace: '../projects' }));
write(path.join(OLD, 'repos.json'), JSON.stringify({ defaults: {}, repos: { demo: { dir: 'demo', remote: 'acme/demo', baseBranch: 'main', install: '', gates: [], workflow: { stages: { verify: { use: [{ ref: 'factory-verifier', kind: 'agent' }] } } } } } }));
write(path.join(OLD, 'issues', 'demo-1', 'state.json'), JSON.stringify({ id: 'demo-1', repo: 'demo', issue: 1, kind: 'issue', title: 'One', stage: 'implement', worktree: WORKTREE, branch: 'fix', base: 'main', history: [], rev: 4 }));
write(path.join(CLAUDE, 'skills', 'factory', 'SKILL.md'), '---\nname: factory\n---\n# Codeignite\nRun `factory next <id>`.\n');
write(path.join(CLAUDE, 'agents', 'factory-verifier.md'), '---\nname: factory-verifier\n---\nYou verify a Codeignite task.\n');
write(path.join(CLAUDE, 'skills', 'mine', 'SKILL.md'), 'my own skill');
write(path.join(CLAUDE, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `FACTORY_ROOT='${OLD}' FACTORY_WORKSPACE='${WS}' node '${path.join(BIN, 'guard.mjs')}' pre` }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));

test('an install made under the old name keeps working: its folder, its settings and its command', () => {
  // Only the old folder exists, so it is the one in use.
  assert.equal(factoryRoot(), OLD);
  process.env.FACTORY_PORT = '4999';
  assert.deepEqual([setting('PORT'), boardPort()], ['4999', 4999]);
  process.env.CODEIGNITE_PORT = '4888';
  assert.equal(boardPort(), 4888);
  delete process.env.FACTORY_PORT;
  delete process.env.CODEIGNITE_PORT;
  // The old file name starts the same program, and the old variable names it its data.
  const old = cli('factory.mjs', ['status'], { FACTORY_ROOT: OLD, FACTORY_WORKSPACE: WS });
  assert.equal(old.status, 0, old.out);
  assert.match(old.out, /demo-1\s+implement/);
  assert.match(cli('codeignite.mjs', ['status']).out, /demo-1\s+implement/);
  assert.match(cli('codeignite.mjs', ['help']).out, /Usage: codeignite <command>\s+\(short: cig <command>\)/);
  assert.match(cli('codeignite.mjs', ['nope']).out, /^codeignite: Unknown command "nope"\. Run "codeignite help"/);
});

test('the guard refuses the same actions under every name of the command', () => {
  for (const name of ['codeignite', 'cig', 'factory', 'node bin/codeignite.mjs', 'node bin/factory.mjs']) {
    assert.equal(bash(`${name} approve demo-1`).deny, true, name);
    assert.equal(bash(`${name} serve`).deny, true, name);
    assert.equal(bash(`${name} migrate --yes`).deny, true, name);
    assert.equal(bash(`${name} status demo-1`).deny, false, name);
  }
  assert.equal(bash('FACTORY_ROOT=/tmp/x codeignite status').deny, true);
  assert.equal(bash('CODEIGNITE_ROOT=/tmp/x codeignite status').deny, true);
});

test('a file exported and a workflow saved before the rename are still read', () => {
  assert.equal(planImport({ factoryConfig: 1, projects: {} }).projects.length, 0);
  assert.equal(planImport({ codeigniteConfig: 1, projects: {} }).projects.length, 0);
  assert.throws(() => planImport({ projects: {} }), /not a Codeignite configuration file of format 1\. Create one with "codeignite export <file>"/);
  // The verifier agent named by its earlier name means the agent that is installed now.
  assert.deepEqual(resolveWorkflow('demo').stages.verify.use.map((entry) => entry.ref), ['codeignite-verifier']);
});

test('the board shows the full command where "codeignite" is not on the PATH', () => {
  assert.equal(commandLinked(), false);
  assert.equal(commandText(), `node '${path.join(BIN, 'codeignite.mjs')}'`);
});

test('migrate moves the data folder, repairs the worktrees and renames what it installed', () => {
  const plan = planMigration();
  assert.deepEqual([plan.move, plan.from, plan.to, plan.oldFiles.length], [true, OLD, NEW, 2]);
  // An agent may not run it, and without a terminal it needs --yes.
  assert.match(cli('codeignite.mjs', ['migrate'], { CLAUDECODE: '1' }).out, /runs only in your own terminal/);
  assert.match(cli('codeignite.mjs', ['migrate']).out, /There is no terminal to ask in\. Run "codeignite migrate --yes"/);
  assert.equal(fs.existsSync(OLD), true);

  const done = migrate(plan).join('\n');
  assert.match(done, /Moved .*\.code-factory to .*\.codeignite\./);
  assert.match(done, /Updated the worktree folder of 1 task\(s\) and told Git where they are now\./);
  assert.match(done, /Installed the hooks, the "codeignite" skill and the "codeignite-verifier" agent .* and removed the ones under the old names/);
  assert.deepEqual([fs.existsSync(OLD), fs.existsSync(NEW), factoryRoot()], [false, true, NEW]);

  // The task points at the moved worktree, keeps its revision, and Git works there.
  const moved = path.join(NEW, 'worktrees', 'demo-1');
  const state = JSON.parse(fs.readFileSync(path.join(NEW, 'issues', 'demo-1', 'state.json'), 'utf8'));
  assert.deepEqual([state.worktree, state.rev], [moved, 4]);
  assert.equal(sh(moved, 'git rev-parse --abbrev-ref HEAD'), 'fix');
  assert.match(sh(REPO, 'git worktree list'), new RegExp(`${moved.replace(/[.]/g, '\\.')}\\s`));
  // The workspace that was written relative to the old folder still means the same place.
  assert.equal(JSON.parse(fs.readFileSync(path.join(NEW, 'config.json'), 'utf8')).workspace, WS);
  assert.match(cli('codeignite.mjs', ['status']).out, /demo-1\s+implement/);

  // The hooks name the new folder and the new variables; what the user had beside them stays.
  const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
  const commands = settings.hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.deepEqual([settings.model, commands.includes('echo mine'), commands.filter((c) => c.includes('guard.mjs')).length], ['opus', true, 1]);
  assert.match(commands.find((c) => c.includes('guard.mjs')), new RegExp(`^CODEIGNITE_ROOT='${NEW.replace(/[.]/g, '\\.')}' CODEIGNITE_WORKSPACE=`));
  assert.ok(fs.existsSync(path.join(CLAUDE, 'settings.json.bak')));
  assert.match(fs.readFileSync(path.join(CLAUDE, 'skills', 'codeignite', 'SKILL.md'), 'utf8'), /^---\nname: codeignite\n/);
  assert.ok(fs.existsSync(path.join(CLAUDE, 'agents', 'codeignite-verifier.md')));
  assert.deepEqual([fs.existsSync(path.join(CLAUDE, 'skills', 'factory')), fs.existsSync(path.join(CLAUDE, 'agents', 'factory-verifier.md')), fs.readFileSync(path.join(CLAUDE, 'skills', 'mine', 'SKILL.md'), 'utf8')], [false, false, 'my own skill']);

  // A second run finds nothing to move and changes nothing.
  const again = planMigration();
  assert.deepEqual([again.move, again.oldFiles.length], [false, 0]);
  assert.match(cli('codeignite.mjs', ['migrate', '--yes']).out, /There is no .*\.code-factory, so no data needs to move\./);
});

test('migrate leaves a data folder alone that the environment names, or when both folders exist', () => {
  fs.mkdirSync(OLD, { recursive: true });
  assert.match(planMigration().reason, /Both .*\.code-factory and .*\.codeignite exist/);
  fs.rmSync(OLD, { recursive: true });
  process.env.FACTORY_ROOT = path.join(tmp, 'elsewhere');
  try {
    const plan = planMigration();
    assert.equal(plan.move, false);
    assert.match(plan.reason, /set in the environment .* rename it to CODEIGNITE_ROOT/);
  } finally {
    delete process.env.FACTORY_ROOT;
  }
});
