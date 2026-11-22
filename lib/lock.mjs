// Lets one process at a time change a task or the settings. The CLI, the board and the hooks are separate
// processes that read a file, change it and write it back; without a lock the later writer drops the other's change.
//
// A lock is a file created with the "exclusive" flag, which the system grants to one creator only. It names its
// owner, so a lock left by a process that died is taken over instead of waited for.
import fs from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { factoryRoot, issueDir } from './paths.mjs';

const WAIT_MS = 15_000;
const STEP_MS = 20;
// No holder keeps a lock longer than a few git commands take. Older than this, the owner is taken for dead.
const STALE_MS = 120_000;

// Locks this thread holds, with how many times it entered: a holder may enter its own lock again.
const held = new Map();
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const running = (pid) => {
  try {
    return Number.isInteger(pid) && process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// Returns the owner written in a lock file, or null when the file is gone or unreadable.
function ownerOf(file) {
  try {
    const stat = fs.statSync(file);
    const owner = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    return { ...owner, age: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

function take(file) {
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, thread: threadId, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const owner = ownerOf(file);
  // A file just created and not yet written reads as empty; its owner is alive.
  const dead = owner && (owner.age > STALE_MS || (owner.pid !== undefined && !running(owner.pid)));
  if (dead) {
    // Only the lock that was judged is removed: one taken meanwhile by another process has a different owner.
    const again = ownerOf(file);
    if (again && again.pid === owner.pid && again.at === owner.at) fs.rmSync(file, { force: true });
  }
  return false;
}

/**
 * Runs fn while holding the lock file and returns what fn returns. Waits up to `wait` milliseconds for another
 * holder, then throws and names it. With `tryOnly`, returns `busy` at once instead of waiting.
 */
export function withLock(file, fn, { wait = WAIT_MS, tryOnly = false, busy = undefined, what = 'this' } = {}) {
  const depth = held.get(file) || 0;
  if (!depth) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const until = Date.now() + wait;
    while (!take(file)) {
      if (tryOnly) return busy;
      if (Date.now() > until) {
        const owner = ownerOf(file);
        throw new Error(`Another Codeignite command${owner?.pid ? ` (process ${owner.pid})` : ''} is changing ${what} and did not finish within ${Math.round(wait / 1000)} seconds. Nothing was written; run the command again.`);
      }
      pause(STEP_MS);
    }
  }
  held.set(file, depth + 1);
  try {
    return fn();
  } finally {
    if (depth) held.set(file, depth);
    else {
      held.delete(file);
      fs.rmSync(file, { force: true });
    }
  }
}

const taskLock = (id) => path.join(issueDir(id), '.lock');

/** Runs fn as the only process changing the task. A task that does not exist needs no lock: fn reports it. */
export function withTask(id, fn, options = {}) {
  if (!fs.existsSync(issueDir(id))) return fn();
  return withLock(taskLock(id), fn, { what: id, ...options });
}

/** Runs fn as the only process changing the settings: the project registry, the workflow and config.json. */
export const withSettings = (fn, options = {}) => withLock(path.join(factoryRoot(), '.settings.lock'), fn, { what: 'the settings', ...options });
