#!/usr/bin/env node
// Stands in for a coding harness in the tests: prints the events of one session and acts on the task as told.
// FAKE_AGENT picks the behavior: advance | idle | fail | hang | silent | tree | junk | background | twice | longline. The task id is read from the prompt.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

if (process.argv.includes('--version')) {
  console.log('0.0.0 (fake agent)');
  process.exit(0);
}
// The smallest request, made only to learn the plan's usage: answer, report usage when told to, and leave.
if (process.argv.includes('--no-session-persistence')) {
  if (process.env.FAKE_AGENT_PROBES) fs.appendFileSync(process.env.FAKE_AGENT_PROBES, 'probe\n');
  if (process.env.FAKE_PROBE === 'dead') process.exit(1);
  const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  out({ type: 'system', subtype: 'init', session_id: 'probe', model: 'fake-model', apiKeySource: 'none' });
  // Starts and dies before it answers, as when the network drops.
  if (process.env.FAKE_PROBE === 'crash') process.exit(1);
  if (process.env.FAKE_USAGE) out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: Number(process.env.FAKE_USAGE), resetsAt: Math.round(Date.now() / 1000) + 3600 } } } });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.0001, result: 'ok' });
  process.exit(0);
}
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
const id = /Codeignite task (\S+?)\./.exec(prompt)?.[1];
const mode = process.env.FAKE_AGENT || 'advance';
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const NEXT = { triage: 'implement', implement: 'gates', gates: 'ready' };

if (process.env.FAKE_AGENT_ARGS) fs.appendFileSync(process.env.FAKE_AGENT_ARGS, `${JSON.stringify({ args: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY || null, port: process.env.CODEIGNITE_TASK_PORT || null, task: process.env.CODEIGNITE_TASK_ID || null, nested: process.env.CLAUDECODE || null, cwd: process.cwd() })}\n`);
if (mode === 'silent') process.exit(3);
say({ type: 'system', subtype: 'init', session_id: `fake-${process.pid}`, model: 'fake-model', apiKeySource: 'none' });
say({ type: 'assistant', message: { content: [{ type: 'text', text: `Working on ${id}.` }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --secret-flag' } }] } });
// FAKE_USAGE is the share of the plan's 5-hour window the harness reports as used, from 0 to 1.
if (process.env.FAKE_USAGE) say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: Number(process.env.FAKE_USAGE), resetsAt: Math.round(Date.now() / 1000) + Number(process.env.FAKE_USAGE_RESETS || 3600) }, seven_day: { utilization: 0.1, resetsAt: Math.round(Date.now() / 1000) + 86400 } } } });
// A reading without a number, and a line far longer than any event.
if (process.env.FAKE_USAGE_NULL) say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: null, resetsAt: Math.round(Date.now() / 1000) + 3600 } } } });
if (mode === 'longline') process.stdout.write(`${'x'.repeat(9 * 1024 * 1024)}\n`);
if (mode === 'junk') {
  // Lines a harness could print that are not what the adapter expects.
  for (const line of ['', 'not json', 'null', '[]', '{"type":"assistant","message":{"content":[null,5,{"type":"tool_use"}]}}', '{"type":"assistant"}', '{"type":"result","subtype":"success","permission_denials":[null]}']) process.stdout.write(`${line}\n`);
  process.exit(0);
}
if (mode === 'tree') {
  // A command the session started and did not wait for; its process id is left for the test to check.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_AGENT_CHILD, String(child.pid));
}
if (mode === 'hang' || mode === 'tree') {
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
} else {
  if (mode === 'background') {
    // A command left running that still holds the session's output, like a development server started with "&".
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    fs.writeFileSync(process.env.FAKE_AGENT_CHILD, String(child.pid));
    child.unref();
  }
  if (['advance', 'background', 'twice', 'longline'].includes(mode)) {
    const file = path.join(process.env.CODEIGNITE_ROOT, 'issues', id, 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.stage = NEXT[state.stage] || state.stage;
    fs.writeFileSync(file, JSON.stringify(state));
  }
  say({ type: 'result', subtype: mode === 'fail' ? 'error_during_execution' : 'success', is_error: mode === 'fail', num_turns: 2, total_cost_usd: 0.01, result: mode === 'fail' ? '' : 'Stage done.', errors: mode === 'fail' ? ['The model refused.'] : undefined, permission_denials: mode === 'idle' ? [{ tool_name: 'Bash', tool_input: { command: 'curl https://example.com/x?token=abc' } }] : [] });
  if (mode === 'twice') say({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.01, result: 'Stage done.' });
}
