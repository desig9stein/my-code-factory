// Moves an install made before the rename to the new names: the data folder, the paths recorded in it,
// Git's record of the worktrees, and the hooks, skill and agent in the Claude Code settings.
import fs from 'node:fs';
import path from 'node:path';
import { readRun } from './agents.mjs';
import { claudeSettingsPath, hooksPresent, installAgentFiles, installHooks } from './hooks.mjs';
import { newRoot, oldRoot, setting } from './paths.mjs';
import { run } from './sh.mjs';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

/** Says what migrating would do: { move, from, to, reason, oldFiles }. Nothing is changed. */
export function planMigration() {
  const from = oldRoot();
  const to = newRoot();
  const claude = path.dirname(claudeSettingsPath());
  // Files an earlier install wrote into the Claude Code folder; only ones that are recognisably ours are removed.
  const oldFiles = [path.join(claude, 'skills', 'factory', 'SKILL.md'), path.join(claude, 'agents', 'factory-verifier.md')].filter((file) => {
    try {
      return /Codeignite|factory next/.test(fs.readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
  });
  if (setting('ROOT')) return { move: false, from, to, oldFiles, reason: `The data folder is set in the environment (${setting('ROOT')}), so it stays where it is. If the variable is still called FACTORY_ROOT, rename it to CODEIGNITE_ROOT in your shell profile; the old name keeps working.` };
  if (!fs.existsSync(from)) return { move: false, from, to, oldFiles, reason: `There is no ${from}, so no data needs to move.` };
  if (fs.existsSync(to)) return { move: false, from, to, oldFiles, reason: `Both ${from} and ${to} exist. ${to} is in use; move or remove one of them by hand, then run this again.` };
  return { move: true, from, to, oldFiles, reason: '' };
}

/** Applies a plan from planMigration and returns the lines that say what was done. */
export function migrate(plan) {
  const done = [];
  if (plan.move) {
    const ids = fs.existsSync(path.join(plan.from, 'issues')) ? fs.readdirSync(path.join(plan.from, 'issues')) : [];
    const busy = ids.filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) && ['running', 'queued'].includes(readRun(id)?.status));
    if (busy.length) throw new Error(`An agent runs on ${busy.join(', ')}. Stop it on the board and stop the board, then run this again.`);
    // A workspace written relative to the data folder would point elsewhere once the folder has moved.
    const configFile = path.join(plan.from, 'config.json');
    let workspace = null;
    if (fs.existsSync(configFile)) {
      const config = readJson(configFile);
      if (config.workspace) {
        workspace = path.resolve(plan.from, config.workspace);
        writeJson(configFile, { ...config, workspace });
      }
    }
    fs.renameSync(plan.from, plan.to);
    done.push(`Moved ${plan.from} to ${plan.to}.`);
    // Every task records the folder of its worktree, and Git records it too.
    const moved = [];
    const inside = (value) => typeof value === 'string' && (value === plan.from || value.startsWith(`${plan.from}${path.sep}`));
    for (const id of ids) {
      const file = path.join(plan.to, 'issues', id, 'state.json');
      try {
        const state = readJson(file);
        if (!inside(state.worktree)) continue;
        state.worktree = plan.to + state.worktree.slice(plan.from.length);
        writeJson(file, state);
        if (fs.existsSync(state.worktree)) moved.push({ repo: state.repo, worktree: state.worktree });
      } catch {
        // A task that cannot be read is left as it is and reported by "codeignite status".
      }
    }
    let registry = { repos: {} };
    try {
      registry = readJson(path.join(plan.to, 'repos.json'));
    } catch {
      // Without a registry there are no repositories to tell.
    }
    const failed = [];
    for (const [key, repo] of Object.entries(registry.repos || {})) {
      const paths = moved.filter((item) => item.repo === key).map((item) => item.worktree);
      if (!paths.length) continue;
      const dir = path.resolve(workspace || path.resolve(plan.to, '..'), repo.dir || key);
      if (run('git', ['-C', dir, 'worktree', 'repair', ...paths]).status !== 0) failed.push(key);
    }
    if (moved.length) done.push(`Updated the worktree folder of ${moved.length} task(s) and told Git where they are now.`);
    if (failed.length) done.push(`Git could not be told for: ${failed.join(', ')}. In each of those repositories run "git worktree repair <worktree folder>".`);
  } else {
    done.push(plan.reason);
  }
  // The hooks name the data folder and the settings by their old names; the skill and the agent have new names.
  if (hooksPresent() || plan.oldFiles.length) {
    const hooks = installHooks();
    const files = installAgentFiles();
    for (const file of plan.oldFiles) fs.rmSync(file, { force: true });
    for (const dir of new Set(plan.oldFiles.filter((file) => file.endsWith('SKILL.md')).map((file) => path.dirname(file)))) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // Something else is in the folder; it stays.
      }
    }
    done.push(`Installed the hooks, the "codeignite" skill and the "codeignite-verifier" agent in ${path.dirname(hooks.file)}${plan.oldFiles.length ? ', and removed the ones under the old names' : ''}${files.some((f) => f.backup) || hooks.backup ? ' (the previous files are kept as .bak)' : ''}. Restart running Claude Code sessions.`);
  }
  return done;
}
