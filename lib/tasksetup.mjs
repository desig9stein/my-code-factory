// Runs a project's setup command for one task and says what came of it.
import fs from 'node:fs';
import path from 'node:path';
import { runRecorded } from './evidence.mjs';
import { withTask } from './lock.mjs';
import { issueDir } from './paths.mjs';
import { tryGit } from './sh.mjs';
import { loadState, saveState } from './state.mjs';

const markerPath = (id) => path.join(issueDir(id), '.setting-up');
const alive = (pid) => {
  try {
    return Number.isInteger(pid) && process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** Returns true while a setup command runs for the task. A marker left by a process that died does not count. */
export function settingUp(id) {
  try {
    return alive(Number(fs.readFileSync(markerPath(id), 'utf8')));
  } catch {
    return false;
  }
}

// Adds a line to the task's history from the newest stored state.
function note(id, text) {
  withTask(id, () => {
    const state = loadState(id);
    state.history.push({ stage: state.stage, at: new Date().toISOString(), note: text });
    saveState(state);
  });
}

/**
 * Runs the setup command in the task's folder and records it. Returns { record, leftovers }: the evidence record,
 * and the files setup wrote that Git does not ignore. Those would make every check refuse the folder as changed,
 * so they are named now and not found out later.
 */
export function runSetup(state, repo) {
  fs.writeFileSync(markerPath(state.id), String(process.pid));
  let record;
  try {
    record = runRecorded(state, { name: 'setup', kind: 'setup', cmd: repo.setup, cwd: state.worktree, timeoutMinutes: 15 });
  } finally {
    fs.rmSync(markerPath(state.id), { force: true });
  }
  const leftovers = (tryGit(state.worktree, 'status', '--porcelain') || '').split('\n').filter((line) => line.startsWith('?? ')).map((line) => line.slice(3));
  if (!record.ok) note(state.id, `Setup failed (exit ${record.exitCode}). Run "codeignite run ${state.id} setup" after fixing the cause.`);
  else if (leftovers.length) note(state.id, `Setup left files Git does not ignore: ${leftovers.slice(0, 5).join(', ')}${leftovers.length > 5 ? ` and ${leftovers.length - 5} more` : ''}. Add them to .gitignore; until then the checks refuse the folder as changed.`);
  return { record, leftovers };
}
