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

/** Runs git in cwd and returns trimmed stdout, or null on failure. */
export function tryGit(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Runs a program and returns { status, stdout, stderr }. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || r.error?.message || '' };
}
