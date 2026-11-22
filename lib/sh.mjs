// Runs git and shell commands synchronously.
import { spawnSync } from 'node:child_process';

/** Runs git in cwd and returns trimmed stdout; throws with stderr on failure. */
export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.error?.message || '').trim()}`);
  }
  return r.stdout.trim();
}

const RUN_TIMEOUT_MS = 60_000;
let remembered = null;
/**
 * Runs fn with read-only git answers remembered for its duration.
 * Building the board asks the same questions (HEAD, merge base, status) many times per task; nothing in it changes a repository.
 */
export function rememberingGit(fn) {
  if (remembered) return fn();
  remembered = new Map();
  try {
    return fn();
  } finally {
    remembered = null;
  }
}

/** Runs git in cwd and returns trimmed stdout, or null on failure. */
export function tryGit(cwd, ...args) {
  const key = remembered ? `${cwd}\u0000${args.join('\u0000')}` : null;
  if (key && remembered.has(key)) return remembered.get(key);
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = r.status === 0 ? r.stdout.trim() : null;
  if (key) remembered.set(key, out);
  return out;
}

/** Runs a program and returns { status, stdout, stderr }. */
export function run(cmd, args, opts = {}) {
  // The board calls this while it answers a request; a program that waits on the network must not hold it for good.
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: RUN_TIMEOUT_MS, ...opts });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: timedOut ? `${cmd} did not answer within ${RUN_TIMEOUT_MS / 1000} seconds.` : r.stderr || r.error?.message || '' };
}
