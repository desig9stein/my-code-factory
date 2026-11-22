// Runs a project's setup command for one task and says what came of it.
import fs from 'node:fs';
import path from 'node:path';
import { runRecorded } from './evidence.mjs';
import { withTask } from './lock.mjs';
import { issueDir } from './paths.mjs';
import { tryGit } from './sh.mjs';
import { loadState, saveState } from './state.mjs';

const markerPath = (id) => path.join(issueDir(id), '.setting-up');
// No setup runs longer than its limit; a marker older than this was left by a process whose number another program has now.
const MARKER_MS = 6 * 60 * 60_000;
const alive = (pid) => {
  try {
    return Number.isInteger(pid) && pid > 1 && process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
};
const markerOwner = (id) => {
  try {
    const file = markerPath(id);
    const pid = Number(fs.readFileSync(file, 'utf8').trim() || NaN);
    return alive(pid) && Date.now() - fs.statSync(file).mtimeMs < MARKER_MS ? pid : null;
  } catch {
    return null;
  }
};

/** Returns true while a setup command runs for the task. A marker left by a process that died does not count. */
export const settingUp = (id) => markerOwner(id) !== null;

// Adds a line to the task's history from the newest stored state.
function note(id, text) {
  withTask(id, () => {
    const state = loadState(id);
    state.history.push({ stage: state.stage, at: new Date().toISOString(), note: text });
    saveState(state);
  });
}

// The files Git neither tracks nor ignores, by their real names.
const untracked = (dir) => new Set((tryGit(dir, 'ls-files', '--others', '--exclude-standard', '-z') || '').split('\0').filter(Boolean));

/**
 * Runs the setup command in the task's folder and records it. Returns { record, leftovers }: the evidence record,
 * and the files setup wrote that Git does not ignore. Those would make every check refuse the folder as changed,
 * so they are named now and not found out later.
 */
export function runSetup(state, repo) {
  // One setup at a time: a second one would end first and say the folder is ready while the first still writes to it.
  const claimed = withTask(state.id, () => {
    if (markerOwner(state.id) !== null) return false;
    fs.writeFileSync(markerPath(state.id), String(process.pid));
    return true;
  });
  if (!claimed) throw new Error(`The setup command of ${state.id} is running already. Wait for it to finish.`);
  const before = untracked(state.worktree);
  let record;
  try {
    record = runRecorded(state, { name: 'setup', kind: 'setup', cmd: repo.setup, cwd: state.worktree, timeoutMinutes: repo.timeoutMinutes ?? 15 });
  } finally {
    if (markerOwner(state.id) === process.pid) fs.rmSync(markerPath(state.id), { force: true });
  }
  // Only what the setup added: a file that was there before is the user's, not the setup's.
  const leftovers = [...untracked(state.worktree)].filter((file) => !before.has(file)).map((file) => (/[\u0000-\u001f\u007f]/.test(file) ? JSON.stringify(file) : file));
  if (!record.ok) note(state.id, `Setup failed (exit ${record.exitCode}). Run "codeignite run ${state.id} setup" after fixing the cause.`);
  else if (leftovers.length) note(state.id, `Setup left files Git does not ignore: ${leftovers.slice(0, 5).join(', ')}${leftovers.length > 5 ? ` and ${leftovers.length - 5} more` : ''}. Add them to .gitignore; until then the checks refuse the folder as changed.`);
  return { record, leftovers };
}
