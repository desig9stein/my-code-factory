// Records which tools an agent used on a task, per stage, from the session hooks.
// Stores tool names, counts and times only: no command text beyond its first word, no file paths, no content.
import fs from 'node:fs';
import path from 'node:path';
import { issueDir, namesId, within } from './paths.mjs';
import { stagesOf } from './state.mjs';

const activityPath = (id) => path.join(issueDir(id), 'activity.jsonl');
const ACTIVE_MS = 60_000;
const clean = (value, max = 48) => String(value || '').replace(/[^\w.:@/ -]/g, '').slice(0, max);

/** Returns the tasks a hook payload concerns: it runs inside the worktree, or its input names the task. */
export function tasksOf(states, input) {
  const cwd = input.cwd || '';
  const text = `${cwd} ${JSON.stringify(input.tool_input || {})}`;
  return states.filter((s) => (cwd && s.worktree && within(cwd, s.worktree)) || namesId(text, s.id));
}

// Reduces a shell command to its program name: "FOO=1 npm test -- x" becomes "npm".
function program(command) {
  const word = String(command || '').trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) || '';
  return clean(path.basename(word).replace(/^["']|["']$/g, ''), 24);
}

/** Describes a tool call as { kind, label, detail } without keeping its arguments. */
export function describeCall(input) {
  const name = String(input.tool_name || '');
  const args = input.tool_input || {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { kind: 'mcp', label: clean(mcp[1]), detail: clean(mcp[2]) };
  if (name === 'Skill') return { kind: 'skill', label: clean(args.skill || args.name || args.command || 'skill'), detail: '' };
  if (name === 'Agent' || name === 'Task') return { kind: 'agent', label: clean(args.subagent_type || 'general-purpose'), detail: '' };
  if (name === 'Bash') return { kind: 'tool', label: 'Bash', detail: program(args.command) };
  return { kind: 'tool', label: clean(name) || 'unknown', detail: '' };
}

/** Appends one line per concerned task for a tool call that is about to run. */
export function recordActivity(states, input) {
  if (!input.tool_name) return [];
  const touched = tasksOf(states, input);
  const call = describeCall(input);
  for (const s of touched) {
    if (!fs.existsSync(issueDir(s.id))) continue;
    const line = { at: new Date().toISOString(), stage: s.blocked ? 'blocked' : s.stage, ...call };
    if (input.tool_use_id) line.use = String(input.tool_use_id).slice(0, 80);
    // Set by the harness when the call comes from inside a subagent.
    if (input.agent_type) line.agent = clean(input.agent_type);
    fs.appendFileSync(activityPath(s.id), `${JSON.stringify(line)}\n`);
  }
  return touched;
}

/** Reads the recorded calls of a task; unreadable lines are skipped. */
export function readActivity(id) {
  let text;
  try {
    text = fs.readFileSync(activityPath(id), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

/** Returns the tool-call ids recorded for a task, used to attribute transcript usage. */
export const activityUseIds = (id) => new Set(readActivity(id).map((r) => r.use).filter(Boolean));

// Finished time in each stage, from the stage history. The open visit to the current stage is left out:
// the reader adds it from `since`, so the summary does not change with every reading.
function stageTimes(state) {
  const moves = state.history.filter((h) => stagesOf(state).includes(h.stage));
  const end = state.history.find((h) => h.stage === 'archived')?.at || null;
  const ms = {};
  moves.forEach((h, i) => {
    const until = moves[i + 1]?.at || end;
    ms[h.stage] = (ms[h.stage] || 0) + (until ? Math.max(0, new Date(until) - new Date(h.at)) : 0);
  });
  return { ms, open: end ? null : moves.at(-1) || null };
}

/**
 * Summarizes a task's agent activity: the last call, and per stage the time spent and what was used.
 * `recorded` is false when no hook ever reported a call, which is unknown activity, not none.
 */
export function activitySummary(state) {
  const records = readActivity(state.id);
  const { ms, open } = stageTimes(state);
  const byStage = stagesOf(state).map((stage) => {
    const counts = new Map();
    for (const r of records) {
      if (r.stage !== stage) continue;
      const key = `${r.kind}\u0000${r.label}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const items = [...counts].map(([key, count]) => ({ kind: key.split('\u0000')[0], label: key.split('\u0000')[1], count })).sort((a, b) => b.count - a.count);
    return { stage, ms: ms[stage] ?? null, since: open?.stage === stage ? open.at : null, calls: items.reduce((n, i) => n + i.count, 0), items };
  });
  const last = records.at(-1) || null;
  return {
    recorded: records.length > 0,
    calls: records.length,
    last: last ? { at: last.at, stage: last.stage, kind: last.kind, label: last.label, detail: last.detail || '', agent: last.agent || '' } : null,
    activeWindowMs: ACTIVE_MS,
    byStage,
  };
}
