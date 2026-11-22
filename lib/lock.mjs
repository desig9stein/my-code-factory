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
// A lock whose owner cannot be read (a damaged file) is taken for abandoned once it is this old.
const STALE_MS = 120_000;
// A holder that still runs keeps its lock however long its command takes: a setup or teardown command runs for
// minutes inside it. Past this age the process id is taken to belong to another program that got the same number.
const REUSED_MS = 60 * 60_000;
const REAP_MS = 5_000;

// Locks this thread holds, with how many times it entered: a holder may enter its own lock again.
const held = new Map();
const owners = new Map();
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const running = (pid) => {
  try {
    return Number.isInteger(pid) && pid > 0 && process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// Returns the owner written in a lock file with the file's age, or null when the file is gone. A file that cannot
// be read as a lock (damaged, or a folder) has an age and no owner.
function ownerOf(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const age = Date.now() - stat.mtimeMs;
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    return owner && typeof owner === 'object' && !Array.isArray(owner) ? { ...owner, age } : { age };
  } catch {
    return { age };
  }
}

const mine = (owner, me) => Boolean(owner && me && owner.pid === me.pid && owner.thread === me.thread && owner.at === me.at && owner.nonce === me.nonce);
const abandoned = (owner) => owner.pid === undefined ? owner.age > STALE_MS : !running(owner.pid) || owner.age > REUSED_MS;

// Removes an abandoned lock. Only one process at a time does this, and it looks again once it is the one, so a
// lock another process took meanwhile is never the one removed.
function reap(file, judged) {
  const gate = `${file}.reap`;
  try {
    fs.writeFileSync(gate, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      if (Date.now() - fs.statSync(gate).mtimeMs > REAP_MS) fs.rmSync(gate, { force: true });
    } catch {
      // Gone already.
    }
    return;
  }
  try {
    const now = ownerOf(file);
    if (now && now.pid === judged.pid && now.at === judged.at && now.nonce === judged.nonce && abandoned(now)) fs.rmSync(file, { force: true, recursive: true });
  } finally {
    fs.rmSync(gate, { force: true });
  }
}

// Returns the owner record written when the lock was taken, or null when another holds it.
function take(file) {
  const me = { pid: process.pid, thread: threadId, at: new Date().toISOString(), nonce: Math.random().toString(36).slice(2) };
  try {
    fs.writeFileSync(file, JSON.stringify(me), { flag: 'wx' });
    return me;
  } catch (err) {
    if (err.code !== 'EEXIST' && err.code !== 'EISDIR') throw err;
  }
  const owner = ownerOf(file);
  // A file just created and not yet written reads as having no owner; it is young, so its owner is alive.
  if (owner && abandoned(owner)) reap(file, owner);
  return null;
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
    let me;
    while (!(me = take(file))) {
      if (tryOnly) return busy;
      if (Date.now() > until) {
        const owner = ownerOf(file);
        const who = owner?.pid ? ` (process ${owner.pid})` : '';
        const hint = owner && owner.pid === undefined ? ` Its lock file ${file} cannot be read; it is removed by itself two minutes after it was written.` : '';
        throw new Error(`Another Codeignite command${who} is changing ${what} and did not finish within ${Math.round(wait / 1000)} seconds. Nothing was written; run the command again.${hint}`);
      }
      pause(STEP_MS);
    }
    owners.set(file, me);
  }
  held.set(file, depth + 1);
  try {
    return fn();
  } finally {
    if (depth) held.set(file, depth);
    else {
      held.delete(file);
      // Only this holder's own lock is removed: one that was taken over and taken again belongs to another.
      const me = owners.get(file);
      owners.delete(file);
      if (mine(ownerOf(file), me)) fs.rmSync(file, { force: true });
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
