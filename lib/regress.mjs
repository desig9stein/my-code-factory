// Proves a regression test fails on the base commit and passes on the fix.
import fs from 'node:fs';
import path from 'node:path';
import { mergeBase } from './checks.mjs';
import { runRecorded } from './evidence.mjs';
import { subdirOf, worktreesDir } from './paths.mjs';
import { git, tryGit } from './sh.mjs';
import { head, isDirty } from './state.mjs';

// Lists node_modules folders up to three levels deep, skipping nested ones.
function findNodeModules(root, rel = '', depth = 0) {
  const found = [];
  if (depth > 3) return found;
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const child = path.join(rel, entry.name);
    if (entry.name === 'node_modules') found.push(child);
    else if (entry.isDirectory() && !entry.isSymbolicLink()) found.push(...findNodeModules(root, child, depth + 1));
  }
  return found;
}

/**
 * Runs cmd on the base commit with only the test files from HEAD, then on HEAD.
 * Returns { base, fix }; the proof holds when both records are ok.
 */
export function regress(state, repo, { tests, cmd, subdir = '', actor = 'implementer', match = null }) {
  if (!tests.length) throw new Error('regress needs --tests <path[,path]>: the test files the fix adds or changes.');
  if (!cmd) throw new Error('regress needs the test command after "--".');
  if (isDirty(state)) throw new Error('The worktree has uncommitted changes. Commit the fix and the test first.');

  const fixCwd = subdirOf(state.worktree, subdir);

  const fixSha = head(state);
  const baseSha = mergeBase(state);
  const tmp = path.join(worktreesDir(), `.regress-${state.id}`);
  if (fs.existsSync(tmp)) tryGit(state.worktree, 'worktree', 'remove', '--force', tmp);
  fs.rmSync(tmp, { recursive: true, force: true });

  git(state.worktree, 'worktree', 'add', '--detach', tmp, baseSha);
  try {
    git(tmp, 'checkout', fixSha, '--', ...tests);
    for (const nm of findNodeModules(state.worktree)) {
      const link = path.join(tmp, nm);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      if (!fs.existsSync(link)) fs.symlinkSync(path.join(state.worktree, nm), link, 'dir');
    }
    const base = runRecorded(state, {
      name: 'regress-base',
      kind: 'regress',
      cmd,
      cwd: path.join(tmp, subdir),
      expect: 'fail',
      sha: fixSha,
      actor,
      match,
      timeoutMinutes: repo.timeoutMinutes,
      extra: { baseSha, testsFromFix: tests },
    });
    const fix = runRecorded(state, {
      name: 'regress-fix',
      kind: 'regress',
      cmd,
      cwd: fixCwd,
      expect: 'pass',
      actor,
      timeoutMinutes: repo.timeoutMinutes,
      extra: { testsFromFix: tests },
    });
    return { base, fix, baseSha, tests };
  } finally {
    tryGit(state.worktree, 'worktree', 'remove', '--force', tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
