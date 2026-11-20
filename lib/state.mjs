// Reads and writes issue state; drops a run back to gates when HEAD moves.
import fs from 'node:fs';
import path from 'node:path';
import { issueDir, issuesDir } from './paths.mjs';
import { REVIEW_STAGES, STAGES } from './pipeline.mjs';
import { tryGit } from './sh.mjs';
import { resolveWorkflow } from './workflow.mjs';

export { REVIEW_STAGES, STAGES };

/** Returns the stage list of the state's kind: an issue to fix or a PR to review. */
export function stagesOf(state) {
  if (state.kind === 'review') return REVIEW_STAGES;
  try {
    return resolveWorkflow(state.repo).order;
  } catch {
    return STAGES;
  }
}

// A moved HEAD sends every stage after the checks back to them: the proof is bound to the gated commit.
function shaBound(state) {
  if (state.kind === 'review') return { stages: ['draft', 'ready', 'approved', 'posted'], back: 'checks' };
  const order = stagesOf(state);
  return { stages: order.slice(order.indexOf('gates') + 1), back: 'gates' };
}

const statePath = (id) => path.join(issueDir(id), 'state.json');

export function exists(id) {
  return fs.existsSync(statePath(id));
}

export function loadState(id) {
  if (!exists(id)) {
    throw new Error(`No factory issue "${id}". Known issues: ${listIds().join(', ') || 'none'}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(statePath(id), 'utf8'));
  } catch (err) {
    throw new Error(`The state of ${id} cannot be read (${err.message}). Restore ${statePath(id)} from a backup, or move the folder away.`);
  }
}

export function saveState(state) {
  const file = statePath(state.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function listIds() {
  if (!fs.existsSync(issuesDir())) return [];
  return fs
    .readdirSync(issuesDir())
    .filter((d) => exists(d))
    .sort();
}

/** Returns every non-archived state, synced with its worktree. */
export function listStates({ archived = false } = {}) {
  unreadable.length = 0;
  return listIds()
    .flatMap((id) => {
      try {
        return [sync(loadState(id))];
      } catch (err) {
        // One damaged task must not hide every other task.
        unreadable.push({ id, reason: err.message });
        return [];
      }
    })
    .filter((s) => archived || !s.archived);
}

const unreadable = [];
/** Returns the tasks the last listStates call could not read, with the reason. */
export const unreadableStates = () => unreadable.map((u) => ({ ...u }));

/** Returns every non-archived state as stored, without asking git; for hooks that run on every tool call. */
export function peekStates() {
  return listIds().flatMap((id) => {
    try {
      const s = JSON.parse(fs.readFileSync(statePath(id), 'utf8'));
      return s.archived ? [] : [s];
    } catch {
      return [];
    }
  });
}

export function move(state, stage, note = '') {
  const at = new Date().toISOString();
  state.stage = stage;
  state.stageSince = at;
  state.history.push({ stage, at, note });
  return state;
}

export function head(state) {
  return fs.existsSync(state.worktree) ? tryGit(state.worktree, 'rev-parse', 'HEAD') : null;
}

export function isDirty(state) {
  const out = tryGit(state.worktree, 'status', '--porcelain');
  return out === null ? true : out.length > 0;
}

/** Moves a SHA-bound stage back to gates when HEAD differs from the gated commit. */
export function sync(state) {
  if (!state.gatesSha) return state;
  const bound = shaBound(state);
  if (!bound.stages.includes(state.stage)) return state;
  const now = head(state);
  if (!now || now === state.gatesSha) return state;
  const note = `HEAD moved from ${state.gatesSha.slice(0, 8)} to ${now.slice(0, 8)}; the checks and the approval repeat.`;
  state.gatesSha = null;
  state.approvedSha = null;
  state.approvedDraftSha256 = null;
  move(state, bound.back, note);
  saveState(state);
  return state;
}
