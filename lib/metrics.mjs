// Derives how each task went from its recorded evidence and stage history. Nothing here is stored.
import { listEvidence } from './evidence.mjs';
import { listStates } from './state.mjs';
import { issueTokens } from './tokens.mjs';

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Returns the measures of one implemented task; a measure with no data is null, never zero. */
export function taskMetrics(state) {
  const records = listEvidence(state.id);
  const gateRuns = records.filter((r) => r.kind === 'gate');
  const own = gateRuns.filter((r) => r.actor === 'implementer');
  const first = new Map();
  for (const r of own) if (!first.has(r.name)) first.set(r.name, r);
  const approvedAt = state.history.find((h) => h.stage === 'approved')?.at || null;
  const tokens = issueTokens(state);
  return {
    id: state.id,
    type: state.type || null,
    tier: state.tier || null,
    stage: state.archived ? 'archived' : state.stage,
    // First pass: the first recorded run of every gate passed on a clean tree.
    firstPass: first.size ? [...first.values()].every((r) => r.ok && !r.dirty) : null,
    failedGateRuns: gateRuns.filter((r) => !r.ok).length,
    verifierFails: records.filter((r) => r.kind === 'verdict' && r.verdict === 'fail').length,
    // A reset is a commit made after the checks passed, which sends the task back to gates.
    resets: state.history.filter((h) => /^HEAD moved/.test(h.note || '')).length,
    blocks: state.history.filter((h) => h.stage === 'blocked').length,
    hoursToApproval: approvedAt ? (new Date(approvedAt) - new Date(state.createdAt)) / 3_600_000 : null,
    freshTokens: tokens.availability === 'unavailable' ? null : tokens.fresh,
    tokensPartial: tokens.availability === 'partial',
  };
}

/** Returns per-task measures for every implemented task, archived ones included, and their summary. */
export function factoryMetrics() {
  const tasks = listStates({ archived: true }).filter((s) => s.kind !== 'review').map(taskMetrics);
  const measured = tasks.filter((t) => t.firstPass !== null);
  const approved = tasks.filter((t) => t.hoursToApproval !== null);
  const sum = (key) => tasks.reduce((n, t) => n + t[key], 0);
  return {
    tasks,
    summary: {
      tasks: tasks.length,
      withGateRuns: measured.length,
      firstPass: measured.filter((t) => t.firstPass).length,
      firstPassRate: measured.length ? measured.filter((t) => t.firstPass).length / measured.length : null,
      approved: approved.length,
      medianHoursToApproval: median(approved.map((t) => t.hoursToApproval)),
      failedGateRuns: sum('failedGateRuns'),
      verifierFails: sum('verifierFails'),
      resets: sum('resets'),
    },
  };
}
