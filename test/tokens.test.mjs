import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-usage-'));
process.env.CODEIGNITE_ROOT = root;
const { linkSession, issueTokens } = await import('../lib/tokens.mjs');
const state = { id: 'app-42', createdAt: '2026-01-01T00:00:00.000Z', history: [] };
fs.mkdirSync(path.join(root, 'issues', state.id), { recursive: true });
const row = (id, output) => JSON.stringify({ type: 'assistant', timestamp: '2026-02-01T00:00:00.000Z', message: { id, content: [{ type: 'tool_use', input: { command: 'codeignite status app-42' } }], usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 20, cache_read_input_tokens: 100 } } });
after(() => fs.rmSync(root, { recursive: true, force: true }));
test('session subtotals reconcile, missing transcripts are partial rather than zero', () => {
  assert.equal(issueTokens(state).availability, 'unavailable');
  const a = path.join(root, 'first.jsonl'), b = path.join(root, 'second.jsonl');
  fs.writeFileSync(a, `${row('a', 3)}\n${row('a', 3)}\n`);
  fs.writeFileSync(b, row('b', 7));
  linkSession(state.id, a); linkSession(state.id, b); linkSession(state.id, a);
  let totals = issueTokens(state, { force: true });
  assert.equal(totals.output, 10); assert.equal(totals.sessions, 2);
  assert.equal(totals.bySession[0].output, 3); assert.equal(totals.bySession[1].output, 7);
  assert.equal(totals.bySession.reduce((sum, s) => sum + s.total, 0), totals.total);
  fs.rmSync(b);
  totals = issueTokens(state, { force: true });
  assert.equal(totals.availability, 'partial'); assert.equal(totals.missingFiles, 1);
  assert.equal(totals.bySession[1].availability, 'unavailable');
  fs.rmSync(a);
  assert.equal(issueTokens(state, { force: true }).availability, 'unavailable');
});
test('a call naming app-42 is not attributed to app-4 or to my-app-42', async () => {
  const { namesId } = await import('../lib/paths.mjs');
  const file = path.join(root, 'prefix.jsonl');
  fs.writeFileSync(file, row('p', 9));
  for (const id of ['app-4', 'pp-42']) {
    fs.mkdirSync(path.join(root, 'issues', id), { recursive: true });
    linkSession(id, file);
    assert.equal(issueTokens({ id, createdAt: state.createdAt, history: [] }, { force: true }).availability, 'unavailable');
  }
  assert.equal(namesId('cd /data/worktrees/app-42/src', 'app-42'), true);
  assert.equal(namesId('"codeignite status app-42"', 'app-42'), true);
  assert.equal(namesId('my-app-42', 'app-42'), false);
  assert.equal(namesId('axb-1', 'a.b-1'), false);
});
test('hooks record tool, skill, agent and MCP use per stage without keeping arguments', async () => {
  const { activitySummary, describeCall, recordActivity, tasksOf } = await import('../lib/activity.mjs');
  const id = 'app-7';
  const worktree = path.join(root, 'worktrees', id);
  fs.mkdirSync(path.join(root, 'issues', id), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const task = { id, stage: 'implement', worktree, history: [{ stage: 'intake', at: '2026-01-01T00:00:00.000Z' }, { stage: 'implement', at: '2026-01-01T00:05:00.000Z' }] };
  const other = { id: 'app-70', stage: 'plan', worktree: path.join(root, 'worktrees', 'app-70'), history: [] };
  assert.deepEqual(describeCall({ tool_name: 'Bash', tool_input: { command: 'TOKEN=secret /usr/bin/npm test -- --grep "private thing"' } }), { kind: 'tool', label: 'Bash', detail: 'npm' });
  assert.deepEqual(describeCall({ tool_name: 'mcp__github__issue_read', tool_input: { q: 'x' } }), { kind: 'mcp', label: 'github', detail: 'issue_read' });
  assert.deepEqual(describeCall({ tool_name: 'Skill', tool_input: { skill: 'factory' } }), { kind: 'skill', label: 'factory', detail: '' });
  assert.equal(describeCall({ tool_name: 'Agent', tool_input: { subagent_type: 'codeignite-verifier', prompt: 'p' } }).label, 'codeignite-verifier');
  // A call inside the worktree counts without naming the task; a sibling id does not match.
  const inside = { cwd: path.join(worktree, 'src'), tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'TOKEN=secret npm test' } };
  assert.deepEqual(tasksOf([task, other], inside).map((s) => s.id), [id]);
  recordActivity([task, other], inside);
  recordActivity([task, other], { cwd: root, tool_name: 'Edit', tool_input: { file_path: `/x/${id}/a.ts` } });
  recordActivity([task, other], { cwd: root, tool_name: 'Read', tool_input: { file_path: '/elsewhere' } });
  const stored = fs.readFileSync(path.join(root, 'issues', id, 'activity.jsonl'), 'utf8');
  assert.doesNotMatch(stored, /secret|a\.ts|TOKEN/);
  const summary = activitySummary(task);
  assert.equal(summary.calls, 2);
  assert.deepEqual([summary.last.label, summary.last.stage], ['Edit', 'implement']);
  const stage = (name) => summary.byStage.find((s) => s.stage === name);
  assert.deepEqual(stage('implement').items, [{ kind: 'tool', label: 'Bash', count: 1 }, { kind: 'tool', label: 'Edit', count: 1 }]);
  assert.deepEqual([stage('intake').ms, stage('intake').since, stage('implement').since], [300000, null, '2026-01-01T00:05:00.000Z']);
  // A task no hook ever reported on has unknown activity, not none.
  assert.equal(activitySummary({ id: 'app-70', stage: 'plan', history: [] }).recorded, false);
  // Usage is attributed through the recorded call id even when the call never names the task.
  const file = path.join(root, 'cwd-only.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-02-01T00:00:00.000Z', message: { id: 'q', content: [{ type: 'tool_use', id: 'toolu_1', input: { command: 'npm test' } }], usage: { input_tokens: 1, output_tokens: 42 } } }));
  linkSession(id, file);
  assert.equal(issueTokens({ id, createdAt: state.createdAt, history: [] }, { force: true }).output, 42);
});
