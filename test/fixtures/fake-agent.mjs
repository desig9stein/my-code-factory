#!/usr/bin/env node
// Stands in for a coding harness in the tests: prints the events of one session and acts on the task as told.
// FAKE_AGENT picks the behavior: advance | idle | fail | hang | silent. The task id is read from the prompt.
import fs from 'node:fs';
import path from 'node:path';

if (process.argv.includes('--version')) {
  console.log('0.0.0 (fake agent)');
  process.exit(0);
}
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
const id = /Codeignite task (\S+?)\./.exec(prompt)?.[1];
const mode = process.env.FAKE_AGENT || 'advance';
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const NEXT = { triage: 'implement', implement: 'gates', gates: 'ready' };

if (process.env.FAKE_AGENT_ARGS) fs.appendFileSync(process.env.FAKE_AGENT_ARGS, `${JSON.stringify({ args: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY || null, nested: process.env.CLAUDECODE || null, cwd: process.cwd() })}\n`);
if (mode === 'silent') process.exit(3);
say({ type: 'system', subtype: 'init', session_id: `fake-${process.pid}`, model: 'fake-model', apiKeySource: 'none' });
say({ type: 'assistant', message: { content: [{ type: 'text', text: `Working on ${id}.` }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --secret-flag' } }] } });
if (mode === 'hang') {
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
} else {
  if (mode === 'advance') {
    const file = path.join(process.env.FACTORY_ROOT, 'issues', id, 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.stage = NEXT[state.stage] || state.stage;
    fs.writeFileSync(file, JSON.stringify(state));
  }
  say({ type: 'result', subtype: mode === 'fail' ? 'error_during_execution' : 'success', is_error: mode === 'fail', num_turns: 2, total_cost_usd: 0.01, result: mode === 'fail' ? '' : 'Stage done.', errors: mode === 'fail' ? ['The model refused.'] : undefined, permission_denials: mode === 'idle' ? [{ tool_name: 'Bash', tool_input: { command: 'curl https://example.com/x?token=abc' } }] : [] });
}
