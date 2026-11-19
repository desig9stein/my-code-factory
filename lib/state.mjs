// Reads and writes issue state; drops a run back to gates when HEAD moves.
import fs from 'node:fs';
import path from 'node:path';
import { issueDir, issuesDir } from './paths.mjs';
import { tryGit } from './sh.mjs';

export const STAGES = [
  'intake',
  'triage',
  'reproduce',
  'plan',
  'implement',
  'gates',
  'verify',
  'ready',
  'approved',
  'pr-opened',
];

export const REVIEW_STAGES = ['intake', 'checks', 'draft', 'ready', 'approved', 'posted'];

/** Returns the stage list of the state's kind: an issue to fix or a PR to review. */
export const stagesOf = (state) => (state.kind === 'review' ? REVIEW_STAGES : STAGES);

// Stages whose proof is bound to the commit the gates ran on, and the stage a moved HEAD returns to.
const SHA_BOUND = {
  issue: { stages: ['verify', 'ready', 'approved', 'pr-opened'], back: 'gates' },
  review: { stages: ['draft', 'ready', 'approved', 'posted'], back: 'checks' },
};

const statePath = (id) => path.join(issueDir(id), 'state.json');

export function exists(id) {
  return fs.existsSync(statePath(id));
}

export function loadState(id) {
  if (!exists(id)) {
    throw new Error(`No factory issue "${id}". Known issues: ${listIds().join(', ') || 'none'}.`);
  }
  return JSON.parse(fs.readFileSync(statePath(id), 'utf8'));
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
  return listIds()
    .map((id) => sync(loadState(id)))
    .filter((s) => archived || !s.archived);
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
  const bound = SHA_BOUND[state.kind === 'review' ? 'review' : 'issue'];
  if (!bound.stages.includes(state.stage) || !state.gatesSha) return state;
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
