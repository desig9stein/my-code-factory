// Covers the runs Codeignite starts by itself: settings, what a session may do, the stage loop and the queue.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
delete process.env.CODEIGNITE_PORT;
Object.assign(process.env, { CODEIGNITE_ROOT: ROOT, CODEIGNITE_WORKSPACE: WS, CODEIGNITE_CLAUDE_BIN: FAKE, FAKE_AGENT_ARGS: ARGS, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), ANTHROPIC_API_KEY: 'sk-test-not-real', CLAUDECODE: '1' });

const { agentSettings, checkProjectAgent, createRunner, haltReason, checkUsage, overBudget, overCap, planUsage, readRun, runTask, runView, saveAgentSettings, sessionPolicy, spendToday } = await import('../lib/agents.mjs');
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
  assert.deepEqual(agentSettings(), { harness: 'claude', permission: 'scoped', account: 'login', maxConcurrent: 2, maxSessions: 12, sessionMinutes: 60, usageCap: 80, dailyBudget: 0, autoStart: false });
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

test('a scoped session may run Codeignite, Git without push and the project commands, and nothing with brackets', () => {
  const policy = sessionPolicy(getRepo('demo'));
  assert.equal(policy.permission, 'scoped');
  for (const prefix of ['factory', 'git commit', 'npm ci', 'npm test']) assert.ok(policy.allow.includes(prefix), prefix);
  assert.ok(policy.allow.some((prefix) => /^node '.*bin\/codeignite\.mjs'$/.test(prefix)));
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
  // The files only Codeignite writes are refused in every mode, also where Codeignite adds no other rule.
  assert.deepEqual(tool.command({ prompt: 'x', permission: 'own', protect: ['/d/state.json'] }).args.slice(-2), ['--disallowedTools', 'Edit(//d/state.json)']);
  assert.deepEqual(tool.command({ prompt: 'x', permission: 'auto', secret: ['/d/.board-key'] }).args.slice(-3), ['--disallowedTools', 'Read(//d/.board-key)', 'Edit(//d/.board-key)']);
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
  assert.match(first.args[1], /^Work on the Codeignite task demo-1\. Start by running: node '.*codeignite\.mjs' next demo-1\nDo only the current stage \("triage"\)/);
  // The default model of the stage is the session's model, and the session uses the login, not the key in the shell.
  assert.equal(first.args[first.args.indexOf('--model') + 1], 'opus');
  assert.deepEqual([first.key, first.nested], [null, null]);
  // The task's documents live outside the worktree, so the session is given that folder too.
  assert.equal(first.args[first.args.indexOf('--add-dir') + 1], path.join(ROOT, 'issues', id));
  assert.ok(first.args.includes(`Read(/${path.join(ROOT, '.board-key')})`));
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
  assert.throws(() => runner.start('demo-999'), /No Codeignite task "demo-999"/);
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
  const server = await startServer(0, { pairing: false });
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
    // What the harness last reported about the plan is read at each request, not kept with the slow parts.
    write(path.join(ROOT, 'cache', 'plan-usage.json'), JSON.stringify({ at: new Date().toISOString(), windows: [{ id: 'five_hour', used: 0.42, resetsAt: null }] }));
    assert.equal((await (await fetch(`${base}/api/agents`)).json()).planUsage.windows[0].used, 0.42);
    fs.rmSync(path.join(ROOT, 'cache', 'plan-usage.json'));
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

test('the board answers only a browser paired from the terminal', async () => {
  const { readKey } = await import('../lib/pairing.mjs');
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Without the cookie: no page content, no token, no data, no action.
    const bare = await fetch(base);
    const text = await bare.text();
    assert.equal(bare.status, 200);
    assert.match(text, /This browser is not paired with the board/);
    assert.ok(!text.includes('__factoryToken') && !text.includes('demo-1'));
    assert.equal((await fetch(`${base}/board-data.js`)).status, 401);
    assert.equal((await fetch(`${base}/api/agents`)).status, 401);
    assert.equal((await fetch(`${base}/api/events`)).status, 401);
    assert.equal((await fetch(`${base}/api/approve`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/ping`)).status, 200);
    // A code is given only for the key, works once, and yields the cookie.
    const start = (key) => fetch(`${base}/api/pair/start`, { method: 'POST', headers: key ? { 'X-Factory-Key': key } : {} });
    assert.equal((await start()).status, 403);
    assert.equal((await start('0'.repeat(64))).status, 403);
    const key = readKey();
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(path.join(ROOT, '.board-key')).mode & 0o077, 0);
    const { code } = await (await start(key)).json();
    assert.equal((await fetch(`${base}/pair?code=nope`)).status, 403);
    const paired = await fetch(`${base}/pair?code=${code}`, { redirect: 'manual' });
    assert.equal(paired.status, 302);
    const cookie = paired.headers.get('set-cookie');
    assert.match(cookie, /^factory_pair_\d+=[0-9a-f]{64}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
    assert.ok(!cookie.includes(key));
    assert.equal((await fetch(`${base}/pair?code=${code}`, { redirect: 'manual' })).status, 403);
    const mine = { Cookie: cookie.split(';')[0] };
    // A cookie of the wrong bytes is an unpaired browser, not an error; a second cookie of the name beside the right one does not unpair.
    const name = cookie.split('=')[0];
    assert.equal((await fetch(`${base}/board-data.js`, { headers: { Cookie: `${name}=${'\u00e9'.repeat(64)}` } })).status, 401);
    assert.equal((await fetch(`${base}/board-data.js`, { headers: { Cookie: `${name}=${'%C3%A9'.repeat(32)}` } })).status, 401);
    assert.equal((await fetch(`${base}/board-data.js`, { headers: { Cookie: `${name}=bad; ${mine.Cookie}` } })).status, 200);
    assert.equal((await fetch(`${base}/api/pair/start`, { method: 'POST', headers: { 'X-Factory-Key': 'k'.repeat(63) + '%' } })).status, 403);
    assert.match(await (await fetch(base, { headers: mine })).text(), /__factoryToken=/);
    assert.equal((await fetch(`${base}/board-data.js`, { headers: mine })).status, 200);
    // The cookie of another board, or a changed one, is not this board's.
    assert.equal((await fetch(`${base}/board-data.js`, { headers: { Cookie: `${cookie.split('=')[0]}=${'a'.repeat(64)}` } })).status, 401);
    assert.equal((await fetch(`${base}/board-data.js`, { headers: { Cookie: `factory_pair_1=${cookie.split('=')[1].split(';')[0]}` } })).status, 401);
    // Paired, an action still needs the page's own token.
    assert.equal((await fetch(`${base}/api/agent/run`, { method: 'POST', headers: mine, body: '{}' })).status, 403);
  } finally {
    server.close();
    server.closeAllConnections();
  }
  // The same browser stays paired when the board starts again.
  const again = await startServer(0);
  again.close();
});

test('agents pause at the share of the plan limit the user set, and start again once the window has reset', async () => {
  const usageFile = path.join(ROOT, 'cache', 'plan-usage.json');
  fs.rmSync(usageFile, { force: true });
  saveAgentSettings({ usageCap: 80, maxConcurrent: 2 });
  assert.throws(() => saveAgentSettings({ usageCap: 101 }), /usageCap must be a whole number from 0 to 100/);
  // Nothing reported yet: the brake has nothing to go by and stops nothing.
  assert.deepEqual([planUsage(), overCap()], [null, null]);
  // Below the share the run goes on, and what the harness reported is kept.
  behave('advance');
  process.env.FAKE_USAGE = '0.5';
  assert.equal((await runTask(task(40, 'triage'))).reason, 'your-turn');
  assert.deepEqual(planUsage().windows.map((w) => [w.id, w.used]), [['five_hour', 0.5], ['seven_day', 0.1]]);
  // Just past the share the session finishes its step; no further session starts.
  process.env.FAKE_USAGE = '0.85';
  const paused = await runTask(task(41, 'triage'));
  assert.deepEqual([paused.reason, paused.sessions.length, paused.sessions[0].ok], ['usage', 1, true]);
  assert.match(paused.detail, /^Agents are paused to keep the share of your plan limit you set aside\. Your 5-hour plan usage is at 85%, and agents pause at 80%\. It resets .* change the share under Settings\.$/);
  // Until the window resets no run starts, from the queue or by hand.
  const runner = createRunner();
  assert.throws(() => runner.start(task(42, 'implement')), /Agents are paused .* 5-hour plan usage is at 85%/);
  const refused = await runTask(task(43, 'implement'));
  assert.deepEqual([refused.reason, refused.sessions.length], ['usage', 0]);
  runner.close();
  // Far past the share a running session is interrupted.
  behave('hang');
  process.env.FAKE_USAGE = '0.97';
  write(usageFile, JSON.stringify({ at: new Date().toISOString(), windows: [{ id: 'five_hour', used: 0.2, resetsAt: Math.round(Date.now() / 1000) + 600 }] }));
  const cut = await runTask(task(44, 'implement'));
  assert.deepEqual([cut.reason, cut.sessions.length], ['usage', 1]);
  // A window that has reset says nothing about now, and 0 switches the brake off.
  write(usageFile, JSON.stringify({ at: new Date().toISOString(), windows: [{ id: 'five_hour', used: 0.99, resetsAt: Math.round(Date.now() / 1000) - 60 }] }));
  assert.equal(overCap(), null);
  write(usageFile, JSON.stringify({ at: new Date().toISOString(), windows: [{ id: 'five_hour', used: 0.99, resetsAt: Math.round(Date.now() / 1000) + 600 }] }));
  assert.equal(overCap().id, 'five_hour');
  saveAgentSettings({ usageCap: 0 });
  assert.equal(overCap(), null);
  // A harness that reports no usage, such as one billed by an API key, leaves the brake without a figure.
  assert.deepEqual(harness('claude').parse(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })), []);
  delete process.env.FAKE_USAGE;
  fs.rmSync(usageFile, { force: true });
  saveAgentSettings({ usageCap: 80 });
});

test('the plan usage is asked for before a run when the last figure is old, and a harness that reports none is said to', async () => {
  const usageFile = path.join(ROOT, 'cache', 'plan-usage.json');
  const probes = path.join(tmp, 'probes.txt');
  process.env.FAKE_AGENT_PROBES = probes;
  const asked = () => (fs.existsSync(probes) ? fs.readFileSync(probes, 'utf8').trim().split('\n').length : 0);
  saveAgentSettings({ usageCap: 80 });
  behave('advance');
  // No figure on file: it is asked for first, and at 90% no session starts at all.
  fs.rmSync(usageFile, { force: true });
  process.env.FAKE_USAGE = '0.9';
  const held = await runTask(task(50, 'triage'));
  assert.deepEqual([held.reason, held.sessions.length, asked()], ['usage', 0, 1]);
  // A fresh figure is not asked for again; one older than half an hour is.
  process.env.FAKE_USAGE = '0.3';
  write(usageFile, JSON.stringify({ at: new Date().toISOString(), windows: [{ id: 'five_hour', used: 0.3, resetsAt: Math.round(Date.now() / 1000) + 600 }] }));
  assert.equal((await runTask(task(51, 'triage'))).reason, 'your-turn');
  assert.equal(asked(), 1);
  write(usageFile, JSON.stringify({ at: new Date(Date.now() - 45 * 60_000).toISOString(), windows: [{ id: 'five_hour', used: 0.99, resetsAt: Math.round(Date.now() / 1000) + 600 }] }));
  assert.equal((await runTask(task(52, 'triage'))).reason, 'your-turn');
  assert.equal(asked(), 2);
  // With the brake off nothing is asked.
  saveAgentSettings({ usageCap: 0 });
  fs.rmSync(usageFile, { force: true });
  await runTask(task(53, 'triage'));
  assert.equal(asked(), 2);
  saveAgentSettings({ usageCap: 80 });
  // A harness that answers without a usage figure, as with an API key: kept as "reported nothing", and the run goes on.
  delete process.env.FAKE_USAGE;
  fs.rmSync(usageFile, { force: true });
  assert.deepEqual(await checkUsage().then((u) => [u.windows.length, u.silent]), [0, true]);
  assert.equal(overCap(), null);
  assert.equal((await runTask(task(54, 'triage'))).reason, 'your-turn');
  assert.equal(planUsage().silent, true);
  // A harness that does not answer at all says nothing: the last figure stays.
  write(usageFile, JSON.stringify({ at: new Date().toISOString(), windows: [{ id: 'five_hour', used: 0.4, resetsAt: null }] }));
  process.env.FAKE_PROBE = 'dead';
  assert.equal((await checkUsage()).windows[0].used, 0.4);
  delete process.env.FAKE_PROBE;
  delete process.env.FAKE_AGENT_PROBES;
  fs.rmSync(usageFile, { force: true });
});

test('agents pause at the cost the user allows per day, whatever the account', async () => {
  const spendFile = path.join(ROOT, 'cache', 'spend.json');
  fs.rmSync(spendFile, { force: true });
  assert.throws(() => saveAgentSettings({ dailyBudget: 2.5 }), /dailyBudget must be a whole number from 0 to 1000/);
  saveAgentSettings({ usageCap: 0, dailyBudget: 0 });
  behave('advance');
  // Every session's estimate is added to the day, cap or no cap. The stand-in reports one cent a session.
  await runTask(task(60, 'triage'));
  assert.deepEqual([spendToday().sessions, spendToday().usd.toFixed(2), overBudget()], [3, '0.03', null]);
  // Yesterday's figure does not count today.
  write(spendFile, JSON.stringify({ day: '2020-01-01', usd: 500, sessions: 9 }));
  assert.deepEqual([spendToday().usd, spendToday().sessions], [0, 0]);
  // At the cap no session starts, by hand or from the queue, and the reason says what the figure is.
  saveAgentSettings({ dailyBudget: 1 });
  write(spendFile, JSON.stringify({ day: spendToday().day, usd: 1.25, sessions: 7 }));
  const held = await runTask(task(61, 'triage'));
  assert.deepEqual([held.reason, held.sessions.length], ['budget', 0]);
  assert.match(held.detail, /^Agents are paused at the cost you allow per day\. Claude Code estimates today's 7 session\(s\) at \$1\.25, and agents pause at \$1 a day\. .* an estimate, not a bill\.$/);
  const runner = createRunner();
  assert.throws(() => runner.start(task(62, 'implement')), /Agents are paused at the cost you allow per day/);
  runner.close();
  // Below the cap a run goes on until the day's sessions reach it.
  write(spendFile, JSON.stringify({ day: spendToday().day, usd: 0.985, sessions: 1 }));
  const reached = await runTask(task(63, 'triage'));
  assert.deepEqual([reached.reason, reached.sessions.length], ['budget', 2]);
  saveAgentSettings({ usageCap: 80, dailyBudget: 0 });
  fs.rmSync(spendFile, { force: true });
});


test('a session that leaves a command behind, repeats its result or prints an endless line still ends as one session', async () => {
  saveAgentSettings({ usageCap: 0, dailyBudget: 0, maxSessions: 12 });
  const spendFile = path.join(ROOT, 'cache', 'spend.json');
  fs.rmSync(spendFile, { force: true });
  // A background command keeps the session's output open; the run does not wait for it, and ends it.
  process.env.FAKE_AGENT_CHILD = path.join(tmp, 'left-behind.pid');
  behave('background');
  const started = Date.now();
  const left = await runTask(task(70, 'gates'));
  assert.deepEqual([left.reason, left.sessions.length, left.sessions[0].ok], ['your-turn', 1, true]);
  assert.ok(Date.now() - started < 15_000, `the run took ${Date.now() - started} ms`);
  const pid = Number(fs.readFileSync(process.env.FAKE_AGENT_CHILD, 'utf8'));
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the command left behind to end');
  // Two result lines are one session's cost.
  fs.rmSync(spendFile, { force: true });
  behave('twice');
  await runTask(task(71, 'gates'));
  assert.deepEqual([spendToday().sessions, spendToday().usd.toFixed(2)], [1, '0.01']);
  // A line of nine megabytes is dropped; the events after it are read as usual.
  behave('longline');
  const long = await runTask(task(72, 'gates'));
  assert.deepEqual([long.reason, long.sessions[0].ok], ['your-turn', true]);
  // A session ended by a signal says so.
  behave('silent');
  assert.match((await runTask(task(73, 'gates'))).detail, /It exited with code 3 and reported no result/);
});

test('a usage figure is kept when the request for it dies, and a reading without a number is not "nothing used"', async () => {
  const usageFile = path.join(ROOT, 'cache', 'plan-usage.json');
  saveAgentSettings({ usageCap: 80 });
  const high = { at: new Date().toISOString(), windows: [{ id: 'seven_day', used: 0.97, resetsAt: Math.round(Date.now() / 1000) + 86_400 }] };
  write(usageFile, JSON.stringify(high));
  // The request starts and dies: nothing was learned, so the figure that pauses agents stays.
  process.env.FAKE_PROBE = 'crash';
  assert.equal((await checkUsage()).windows[0].used, 0.97);
  assert.equal(planUsage().windows[0].used, 0.97);
  delete process.env.FAKE_PROBE;
  // Several askers at once share one request.
  const probes = path.join(tmp, 'probes-shared.txt');
  process.env.FAKE_AGENT_PROBES = probes;
  process.env.FAKE_USAGE = '0.4';
  await Promise.all(Array.from({ length: 6 }, () => checkUsage()));
  assert.equal(fs.readFileSync(probes, 'utf8').trim().split('\n').length, 1);
  delete process.env.FAKE_AGENT_PROBES;
  delete process.env.FAKE_USAGE;
  // A window without a number is no reading.
  process.env.FAKE_USAGE_NULL = '1';
  behave('advance');
  fs.rmSync(usageFile, { force: true });
  await runTask(task(74, 'gates'));
  delete process.env.FAKE_USAGE_NULL;
  assert.deepEqual([planUsage().windows, planUsage().silent], [[], true]);
  // A file edited by hand does not break the brake or the start of a run.
  write(usageFile, JSON.stringify({ at: new Date().toISOString(), windows: [null, 5, { id: 'five_hour' }, { id: 'five_hour', used: 0.2 }] }));
  assert.deepEqual(planUsage().windows, [{ id: 'five_hour', used: 0.2 }]);
  assert.equal(overCap(), null);
  write(usageFile, JSON.stringify({ at: 'not a date', windows: [] }));
  assert.equal(planUsage(), null);
  // A figure a month old does not refuse a start: the run asks again first. Without a reset time the text does not say "after that".
  write(usageFile, JSON.stringify({ at: new Date(Date.now() - 30 * 86_400_000).toISOString(), windows: [{ id: 'seven_day', used: 0.99, resetsAt: null }] }));
  assert.match(overCap().text, /Ask for the figure again under Settings, or change the share there\.$/);
  process.env.FAKE_USAGE = '0.1';
  const runner = createRunner();
  const id = task(75, 'gates');
  assert.equal(runner.start(id), 'running');
  await until(() => readRun(id).status === 'ended', 'the run to end');
  assert.equal(readRun(id).reason, 'your-turn');
  runner.close();
  delete process.env.FAKE_USAGE;
  fs.rmSync(usageFile, { force: true });
});

test('a run follows settings changed meanwhile, ends a session an earlier board left behind, and a waiting run survives bad settings', async () => {
  saveAgentSettings({ usageCap: 0, dailyBudget: 0, maxSessions: 12, maxConcurrent: 1 });
  // The limit is lowered after the first session: the run stops there and not after all three stages.
  behave('advance');
  let lowered = false;
  const run = await runTask(task(80, 'triage'), { onChange: (record) => { if (!lowered && record?.sessions?.[0]?.endedAt) { lowered = true; saveAgentSettings({ maxSessions: 1 }); } } });
  assert.deepEqual([run.reason, run.sessions.length], ['limit', 1]);
  saveAgentSettings({ maxSessions: 12 });
  assert.throws(() => saveAgentSettings(null), /must be a list of settings/);
  // A session whose supervisor died is still at work in the folder: it is ended before a new run starts there.
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  orphan.unref();
  const id = task(81, 'gates');
  write(path.join(ROOT, 'issues', id, 'agent-run.json'), JSON.stringify({ id, status: 'running', supervisor: 2 ** 22 + 777, beat: new Date().toISOString(), startedAt: new Date().toISOString(), session: { pid: orphan.pid, cmd: path.basename(process.execPath) }, sessions: [] }));
  assert.equal((await runTask(id)).reason, 'your-turn');
  await until(() => { try { process.kill(orphan.pid, 0); return false; } catch { return true; } }, 'the left-behind session to end');
  // A process of another program under a recorded number is left alone.
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const id2 = task(82, 'gates');
  write(path.join(ROOT, 'issues', id2, 'agent-run.json'), JSON.stringify({ id: id2, status: 'running', supervisor: 2 ** 22 + 778, startedAt: new Date().toISOString(), session: { pid: other.pid, cmd: 'claude' }, sessions: [] }));
  await runTask(id2);
  assert.equal(process.kill(other.pid, 0), true);
  process.kill(-other.pid, 'SIGKILL');
  // A waiting record without a sign of life is not a waiting run.
  write(path.join(ROOT, 'issues', id2, 'agent-run.json'), JSON.stringify({ id: id2, status: 'queued', supervisor: process.pid, startedAt: new Date().toISOString(), sessions: [] }));
  assert.equal(readRun(id2).reason, 'interrupted');
  // Settings that cannot be read while a run waits: the waiting run ends with the reason, and nothing is thrown.
  behave('hang');
  const runner = createRunner();
  const [a, b, c] = [task(83, 'implement'), task(84, 'implement'), task(85, 'implement')];
  assert.deepEqual([runner.start(a), runner.start(b)], ['running', 'queued']);
  assert.equal(typeof readRun(b).beat, 'string');
  // Room for one more is used at once when the user raises the number.
  saveAgentSettings({ maxConcurrent: 2 });
  runner.kick();
  assert.deepEqual([runner.active().sort(), runner.queued()], [[a, b], []]);
  assert.equal(runner.start(c), 'queued');
  const config = path.join(ROOT, 'config.json');
  const kept = fs.readFileSync(config, 'utf8');
  await until(() => readRun(a)?.sessions[0]?.sessionId, 'the session to start');
  write(config, '{broken');
  runner.stop(a);
  await until(() => readRun(c)?.status === 'ended', 'the waiting run to end');
  assert.match(readRun(c).detail, /^The agent session failed\./);
  write(config, kept);
  runner.close();
  await until(() => runner.active().length === 0, 'the runs to end');
  saveAgentSettings({ usageCap: 80, maxConcurrent: 2 });
});
