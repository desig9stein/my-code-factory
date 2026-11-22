// Covers the runs the factory starts by itself: settings, what a session may do, the stage loop and the queue.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-agents-')));
const ROOT = path.join(tmp, 'data');
const WS = path.join(tmp, 'ws');
const ARGS = path.join(tmp, 'args.jsonl');
const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
fs.chmodSync(FAKE, 0o755);
delete process.env.FACTORY_PORT;
Object.assign(process.env, { FACTORY_ROOT: ROOT, FACTORY_WORKSPACE: WS, FACTORY_CLAUDE_BIN: FAKE, FAKE_AGENT_ARGS: ARGS, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), ANTHROPIC_API_KEY: 'sk-test-not-real', CLAUDECODE: '1' });

const { agentSettings, checkProjectAgent, createRunner, haltReason, readRun, runTask, runView, saveAgentSettings, sessionPolicy } = await import('../lib/agents.mjs');
const { harness, harnesses } = await import('../lib/harnesses.mjs');
const { getRepo } = await import('../lib/registry.mjs');
const { listStates } = await import('../lib/state.mjs');
const { writeJson } = await import('../lib/store.mjs');
const { updateProject } = await import('../lib/setup.mjs');
const { exportConfig } = await import('../lib/share.mjs');
const { startServer } = await import('../lib/server.mjs');

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
fs.mkdirSync(path.join(WS, 'demo'), { recursive: true });
write(path.join(ROOT, 'config.json'), JSON.stringify({ workspace: WS }));
write(path.join(ROOT, 'repos.json'), JSON.stringify({ defaults: {}, repos: { demo: { dir: 'demo', remote: 'acme/demo', baseBranch: 'main', install: 'npm ci', gates: [{ name: 'test', cmd: 'npm test' }] } } }));

// Creates a task at a stage; its "worktree" is a plain folder, which is all a fake session needs.
function task(number, stage, extra = {}) {
  const id = `demo-${number}`;
  const worktree = path.join(ROOT, 'worktrees', id);
  fs.mkdirSync(worktree, { recursive: true });
  write(path.join(ROOT, 'issues', id, 'state.json'), JSON.stringify({ id, repo: 'demo', issue: number, kind: 'issue', title: `Task ${number}`, stage, stageSince: new Date().toISOString(), worktree, branch: `fix/${number}`, base: 'main', history: [{ stage, at: new Date().toISOString(), note: '' }], ...extra }));
  return id;
}
const behave = (mode) => { process.env.FAKE_AGENT = mode; };
const calls = () => fs.readFileSync(ARGS, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${what}.`);
};

test('agent settings have safe defaults, reject bad values and keep the rest of the configuration', () => {
  assert.deepEqual(agentSettings(), { harness: 'claude', permission: 'scoped', account: 'login', maxConcurrent: 2, maxSessions: 12, sessionMinutes: 60, autoStart: false });
  assert.throws(() => saveAgentSettings({ permission: 'bypass' }), /permission must be one of scoped, auto, own/);
  assert.throws(() => saveAgentSettings({ maxConcurrent: 0 }), /maxConcurrent must be a whole number from 1 to 8/);
  assert.throws(() => saveAgentSettings({ harness: 'other' }), /Unknown coding harness "other"\. Known: claude/);
  assert.throws(() => saveAgentSettings({ speed: 'fast' }), /"speed" is not an agent setting/);
  assert.equal(saveAgentSettings({ maxConcurrent: 1, permission: 'own' }).permission, 'own');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).workspace, WS);
  // A value someone typed into the file by hand falls back to the default instead of reaching a session.
  write(path.join(ROOT, 'config.json'), JSON.stringify({ workspace: WS, agents: { permission: 'bypassPermissions', maxConcurrent: 99 } }));
  assert.deepEqual([agentSettings().permission, agentSettings().maxConcurrent], ['scoped', 2]);
});

test('a scoped session may run the factory, Git without push and the project commands, and nothing with brackets', () => {
  const policy = sessionPolicy(getRepo('demo'));
  assert.equal(policy.permission, 'scoped');
  for (const prefix of ['factory', 'git commit', 'npm ci', 'npm test']) assert.ok(policy.allow.includes(prefix), prefix);
  assert.ok(policy.allow.some((prefix) => /^node '.*bin\/factory\.mjs'$/.test(prefix)));
  // Agents often name the folder instead of working in it; reading through "git -C <worktree>" is allowed, writing is not.
  const elsewhere = sessionPolicy(getRepo('demo'), agentSettings(), '/data/worktrees/demo-1').allow;
  assert.ok(elsewhere.includes('git -C /data/worktrees/demo-1 diff') && !elsewhere.some((prefix) => /-C .* (commit|push)/.test(prefix)));
  assert.ok(!policy.allow.some((prefix) => prefix.startsWith('git push')) && policy.deny.includes('git push'));
  assert.throws(() => checkProjectAgent({ allow: ['npm test); Bash(rm'] }), /without brackets/);
  assert.throws(() => checkProjectAgent({ permission: 'root' }), /permission must be one of/);
  // A wildcard would allow every command, and a value that is not text would become a rule nobody wrote.
  assert.throws(() => checkProjectAgent({ allow: ['*'] }), /without brackets or "\*"/);
  assert.throws(() => checkProjectAgent({ allow: [{ cmd: 'npm test' }] }), /Every allowed command must be text/);
  assert.throws(() => checkProjectAgent({ allow: ['a'.repeat(201)] }), /at most 200 characters/);
  assert.deepEqual(checkProjectAgent({ allow: ['npm run test:unit', '  '] }), { allow: ['npm run test:unit'] });
  assert.throws(() => checkProjectAgent({ model: 'x' }), /"model" is not an agent setting of a project/);
  updateProject('demo', { agent: { permission: 'auto', allow: ['npx vitest', ' npx vitest ', ''] } });
  assert.deepEqual(getRepo('demo').agent, { permission: 'auto', allow: ['npx vitest'] });
  assert.equal(sessionPolicy(getRepo('demo')).permission, 'auto');
  assert.ok(sessionPolicy(getRepo('demo')).allow.includes('npx vitest'));
  // What an agent may run is each person's decision: it is not in the file a team shares.
  assert.equal(exportConfig().projects.demo.agent, undefined);
  updateProject('demo', { agent: {} });
  assert.equal(getRepo('demo').agent, undefined);
});

test('the Claude Code command carries the mode, the rules and the model, and drops an API key for the login account', () => {
  const tool = harness('claude');
  assert.deepEqual(harnesses().map((item) => item.id), ['claude']);
  const scoped = tool.command({ prompt: 'hello', model: 'opus', permission: 'scoped', allow: ['npm test'], deny: ['git push'], dirs: ['/data/issues/app-1'], protect: ['/data/issues/app-1/state.json', '/data/issues/app-1/evidence/**'], account: 'login' });
  assert.deepEqual(scoped.args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--add-dir', '/data/issues/app-1', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(npm test:*)', '--disallowedTools', 'Bash(git push:*)', 'Edit(//data/issues/app-1/state.json)', 'Edit(//data/issues/app-1/evidence/**)']);
  // The files only the factory writes are refused in every mode, also where the factory adds no other rule.
  assert.deepEqual(tool.command({ prompt: 'x', permission: 'own', protect: ['/d/state.json'] }).args.slice(-2), ['--disallowedTools', 'Edit(//d/state.json)']);
  assert.deepEqual(tool.parse(JSON.stringify({ type: 'assistant', message: { content: [null, 5, 'x'] } })), []);
  assert.equal(scoped.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(scoped.env.CLAUDECODE, undefined);
  assert.equal(tool.command({ prompt: 'x', permission: 'own', account: 'environment' }).env.ANTHROPIC_API_KEY, 'sk-test-not-real');
  assert.ok(!tool.command({ prompt: 'x', permission: 'own' }).args.includes('--permission-mode'));
  assert.deepEqual(tool.command({ prompt: 'x', permission: 'auto' }).args.slice(-2), ['--permission-mode', 'auto']);
  assert.deepEqual(tool.parse('not json'), []);
  assert.deepEqual(tool.parse(JSON.stringify({ type: 'stream_event', event: {} })), []);
  // A tool call is reduced to names, like the activity record: no arguments reach the log.
  assert.deepEqual(tool.parse(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'TOKEN=abc npm test --flag' } }] } })), [{ type: 'tool', kind: 'tool', label: 'Bash', detail: 'npm' }]);
  assert.deepEqual(tool.parse(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })), []);
  assert.equal(tool.parse(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 5 } }))[0].status, 'rejected');
  assert.equal(tool.parse(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false }))[0].ok, false);
});

test('a run starts one fresh session per stage and stops when the task is the user\'s', async () => {
  write(path.join(ROOT, 'config.json'), JSON.stringify({ workspace: WS }));
  fs.rmSync(ARGS, { force: true });
  behave('advance');
  const id = task(1, 'triage');
  const record = await runTask(id);
  assert.deepEqual([record.status, record.reason, record.sessions.map((s) => s.stage)], ['ended', 'your-turn', ['triage', 'implement', 'gates']]);
  assert.ok(record.sessions.every((s) => s.ok && s.sessionId.startsWith('fake-') && s.turns === 2));
  const [first] = calls();
  assert.equal(calls().length, 3);
  assert.equal(first.cwd, path.join(ROOT, 'worktrees', id));
  assert.match(first.args[1], /^Work on the Codeignite task demo-1\. Start by running: node '.*factory\.mjs' next demo-1\nDo only the current stage \("triage"\)/);
  // The default model of the stage is the session's model, and the session uses the login, not the key in the shell.
  assert.equal(first.args[first.args.indexOf('--model') + 1], 'opus');
  assert.deepEqual([first.key, first.nested], [null, null]);
  // The task's documents live outside the worktree, so the session is given that folder too.
  assert.equal(first.args[first.args.indexOf('--add-dir') + 1], path.join(ROOT, 'issues', id));
  assert.ok(first.args.includes(`Edit(/${path.join(ROOT, 'issues', id, 'state.json')})`) && first.args.includes(`Edit(/${path.join(ROOT, 'issues', id, 'evidence', '**')})`));
  const log = fs.readFileSync(path.join(ROOT, 'issues', id, 'agent.log'), 'utf8');
  assert.match(log, /Session 1: stage "triage", model opus\.\nWorking on demo-1\.\n  Bash npm\n/);
  assert.ok(!log.includes('secret-flag'));
  const view = runView(id);
  assert.deepEqual([view.status, view.sessions, view.stage, view.costUsd.toFixed(2), view.log], ['ended', 3, 'gates', '0.03', `issues/${id}/agent.log`]);
});

test('a run stops and says why when the agent makes no progress, fails or cannot be started', async () => {
  behave('idle');
  const stuck = await runTask(task(2, 'implement'));
  assert.deepEqual([stuck.reason, stuck.sessions.length], ['stalled', 2]);
  assert.match(stuck.detail, /ended 2 sessions in a row without finishing the step\. Refused commands: Bash curl\. Allow them for the project/);
  assert.ok(!JSON.stringify(stuck).includes('token=abc'));

  behave('fail');
  const failed = await runTask(task(3, 'implement'));
  assert.deepEqual([failed.reason, failed.sessions.length], ['error', 1]);
  assert.match(failed.detail, /error_during_execution: The model refused\./);

  behave('silent');
  assert.match((await runTask(task(4, 'implement'))).detail, /exited with code 3 and reported no result/);

  behave('advance');
  assert.equal((await runTask(task(5, 'triage'), { settings: { ...agentSettings(), maxSessions: 1 } })).reason, 'limit');
  assert.equal((await runTask(task(6, 'implement', { blocked: { reason: 'Waiting for the API owner.', kind: 'other' } }))).detail, 'The task is blocked and waits for you. Waiting for the API owner.');
  // A folder that is gone is named as such, not reported as a missing program.
  const lost = task(8, 'implement');
  fs.rmSync(path.join(ROOT, 'worktrees', lost), { recursive: true });
  assert.match((await runTask(lost)).detail, /^The agent session failed\. The worktree of demo-8 is missing: /);
  assert.match((await runTask(task(9, 'made-up'))).detail, /The task is at "made-up", which is not a step of its workflow\./);
  assert.match((await runTask(task(13, 'implement', { repo: 'gone' }))).detail, /The agent session failed\. Unknown repo "gone"/);
  // A session that outlives its time limit is ended, and the run says so.
  behave('hang');
  const slow = await runTask(task(14, 'implement'), { settings: { ...agentSettings(), sessionMinutes: 0.005 } });
  assert.deepEqual([slow.reason, slow.sessions.length], ['timeout', 1]);
  assert.match(slow.detail, /ran longer than the time limit and was ended/);
  // Output the adapter does not expect ends the session without a result; it does not end the process that runs it.
  behave('junk');
  assert.match((await runTask(task(15, 'implement'))).detail, /exited with code 0 and reported no result/);
  behave('advance');
  const missing = await runTask(task(7, 'implement'), { tool: { ...harness('claude'), version: () => null } });
  assert.deepEqual([missing.reason, missing.sessions.length], ['missing', 0]);
  assert.match(missing.detail, /not installed on this machine\. Install Claude Code/);
});

test('the queue runs at most the configured number of agents, and a stop ends a session or leaves the queue', async () => {
  saveAgentSettings({ maxConcurrent: 1 });
  behave('hang');
  const runner = createRunner();
  const [a, b, done] = [task(10, 'implement'), task(11, 'implement'), task(12, 'ready')];
  assert.throws(() => runner.start(done), /demo-12 has nothing for an agent to do\. The task reached a step that is yours\./);
  assert.throws(() => runner.start('demo-999'), /No factory issue "demo-999"/);
  assert.equal(runner.start(a), 'running');
  assert.equal(runner.start(b), 'queued');
  assert.throws(() => runner.start(a), /An agent already runs on demo-10/);
  assert.deepEqual([runner.active(), runner.queued(), readRun(b).status], [[a], [b], 'queued']);
  assert.equal(runner.stop(b), true);
  assert.deepEqual([runner.queued(), readRun(b).reason], [[], 'stopped']);
  assert.equal(runner.stop(b), false);
  await until(() => readRun(a)?.sessions[0]?.sessionId, 'the session to start');
  assert.equal(runView(a).status, 'running');
  assert.equal(runner.stop(a), true);
  await until(() => readRun(a).status === 'ended', 'the run to end');
  assert.deepEqual([readRun(a).reason, runner.active()], ['stopped', []]);
  // A record whose supervising process is gone reads as interrupted, not as running forever.
  write(path.join(ROOT, 'issues', a, 'agent-run.json'), JSON.stringify({ id: a, status: 'running', supervisor: 2 ** 22 + 12345, startedAt: new Date().toISOString(), sessions: [] }));
  assert.equal(readRun(a).reason, 'interrupted');
  assert.equal(haltReason({ stage: 'implement' }), null);
  // A process id can be handed to another program after a crash: a record nobody refreshed is not a running agent.
  write(path.join(ROOT, 'issues', a, 'agent-run.json'), JSON.stringify({ id: a, status: 'running', supervisor: process.pid, beat: new Date(Date.now() - 5 * 60_000).toISOString(), startedAt: new Date().toISOString(), sessions: [] }));
  assert.equal(readRun(a).reason, 'interrupted');
  write(path.join(ROOT, 'issues', a, 'agent-run.json'), JSON.stringify({ id: a, status: 'running', supervisor: process.pid, beat: new Date().toISOString(), startedAt: new Date().toISOString(), sessions: [] }));
  assert.equal(readRun(a).status, 'running');
  // A record cut off while written, or edited by hand, does not take the task off the board.
  write(path.join(ROOT, 'issues', a, 'agent-run.json'), JSON.stringify({ id: a, status: 'ended', sessions: [null, 5, 'x', { stage: 'implement', said: 'y'.repeat(9000), denials: 'none' }] }));
  assert.deepEqual([runView(a).sessions, runView(a).said.length, runView(a).denials], [1, 2000, []]);
  for (const text of ['{{{', '[]', '{"status":"running"}', '']) {
    write(path.join(ROOT, 'issues', a, 'agent-run.json'), text);
    assert.equal(runView(a), null);
  }
  runner.close();
});

test('the board starts and stops an agent only with its token, and shows the run and the settings', async () => {
  saveAgentSettings({ maxConcurrent: 2 });
  behave('hang');
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = /__factoryToken="([0-9a-f]+)"/.exec(await (await fetch(base)).text())[1];
  const call = (pathname, body, headers = { 'X-Factory-Token': token }) => fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const board = async () => { const text = await (await fetch(`${base}/board-data.js`)).text(); return JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))); };
  try {
    const id = task(20, 'implement');
    assert.equal((await call('/api/agent/run', { id }, {})).status, 403);
    assert.equal((await call('/api/agents/settings', { permission: 'auto' }, {})).status, 403);
    assert.match((await (await call('/api/agent/stop', { id })).json()).error, /No agent started from this board runs on demo-20/);
    // Anything but an object is a malformed request and is answered in plain words.
    for (const body of [null, [], 'text', 7]) assert.equal((await (await call('/api/agent/run', body)).json()).error, 'Request body must be a JSON object.');
    assert.deepEqual(await (await call('/api/agent/run', { id })).json(), { ok: true, status: 'running' });
    await until(() => readRun(id)?.sessions[0]?.sessionId, 'the session to start');
    assert.match((await (await call('/api/archive', { id })).json()).error, /An agent runs on demo-20, or waits to\. Stop it first, then archive\./);
    const shown = (await board()).issues.find((i) => i.id === id).run;
    assert.deepEqual([shown.status, shown.stage, shown.harness, shown.permission], ['running', 'implement', 'Claude Code', 'scoped']);
    assert.equal((await call('/api/agent/stop', { id })).status, 200);
    await until(() => readRun(id).status === 'ended', 'the run to end');
    const overview = await (await fetch(`${base}/api/agents`)).json();
    assert.deepEqual([overview.harness.id, overview.settings.maxConcurrent, overview.harness.permissionModes.map((m) => m.id)], ['claude', 2, ['scoped', 'auto', 'own']]);
    assert.match((await (await call('/api/agents/settings', { maxSessions: 99 })).json()).error, /maxSessions must be a whole number from 1 to 40/);
    assert.equal((await (await call('/api/agents/settings', { autoStart: true })).json()).settings.autoStart, true);
    assert.equal((await board()).agents.autoStart, true);
    assert.equal((await (await call('/api/project/update', { key: 'demo', agent: { allow: ['make check'] } })).json()).ok, true);
    assert.deepEqual((await board()).projects[0].agent, { permission: '', allow: ['make check'] });
    assert.match(await (await fetch(`${base}/issues/${id}/agent.log`)).text(), /Run ended: You stopped the agent\./);
    // A body past the limit is refused, and the server answers the next request as usual.
    assert.equal((await (await call('/api/agent/run', { id: 'x'.repeat(2_000_000) })).json()).error, 'Request body is too large.');
    assert.equal((await fetch(`${base}/api/ping`)).status, 200);
    assert.equal((await (await call('/api/agents/settings', { autoStart: false })).json()).settings.autoStart, false);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('stopping a session also ends the commands it started', async () => {
  const pidFile = path.join(tmp, 'grandchild.pid');
  process.env.FAKE_AGENT_CHILD = pidFile;
  behave('tree');
  const runner = createRunner();
  const id = task(30, 'implement');
  runner.start(id);
  await until(() => fs.existsSync(pidFile) && readRun(id)?.sessions[0]?.sessionId, 'the session and its command to start');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), true);
  runner.stop(id);
  await until(() => readRun(id).status === 'ended' && !alive(), 'the run and the command it started to end');
  assert.equal(readRun(id).reason, 'stopped');
  runner.close();
});

test('a file the system leaves in the data folder is not a task, and two writers do not share a temporary file', () => {
  write(path.join(ROOT, 'issues', '.DS_Store'), 'x');
  fs.mkdirSync(path.join(ROOT, 'issues', 'not a task!'), { recursive: true });
  assert.ok(listStates().some((state) => state.id === 'demo-1'));
  const file = path.join(tmp, 'store', 'value.json');
  for (let n = 0; n < 50; n++) writeJson(file, { n });
  assert.deepEqual([JSON.parse(fs.readFileSync(file, 'utf8')), fs.readdirSync(path.dirname(file))], [{ n: 49 }, ['value.json']]);
  // A failed write leaves the old file and no temporary file behind.
  assert.throws(() => writeJson(file, { big: 1n }), /BigInt/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['value.json']);
});
