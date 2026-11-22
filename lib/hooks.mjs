// Generates the Claude Code hook settings and merges them into a settings file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeRoot, factoryRoot, workspace } from './paths.mjs';
import { writeJson } from './store.mjs';
// POSIX shell quoting; generated settings are local to this installation.
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const EVENTS = [['PreToolUse', 'pre'], ['PostToolUse', 'post'], ['SessionStart', 'session']];
// Matches a guard command of any Codeignite installation.
// Also one edited by hand: other quotes, or something added after the mode.
const GUARD = /[\\/]bin[\\/]guard\.mjs['"]?\s+(pre|post|session)\b/;
const isGuard = (hook) => Boolean(hook && typeof hook === 'object' && GUARD.test(String(hook.command || '')));
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

export function hookSettings() {
  if (process.platform === 'win32') throw new Error('Hook command generation currently supports macOS/Linux shells. Configure your runner manually on Windows.');
  const command = mode => `CODEIGNITE_ROOT=${quote(factoryRoot())} CODEIGNITE_WORKSPACE=${quote(workspace())} ${quote(process.execPath)} ${quote(path.join(codeRoot(), 'bin', 'guard.mjs'))} ${mode}`;
  return { hooks: Object.fromEntries(EVENTS.map(([event, mode]) => [event, [{ matcher: '', hooks: [{ type: 'command', command: command(mode) }] }]])) };
}

/** Returns the Claude Code user settings path. */
export const claudeSettingsPath = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) return settings;
  } catch { /* Reported below with the file name. */ }
  throw new Error(`${file} is not a JSON object. Fix it by hand, then run "codeignite hooks --install" again.`);
}

function merged(settings) {
  const ours = hookSettings().hooks;
  // A settings file written by hand may hold anything here; what is not a hook group is left as it is.
  const hooks = { ...record(settings.hooks) };
  for (const [event] of EVENTS) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map((group) => (group && typeof group === 'object' && Array.isArray(group.hooks) ? { ...group, hooks: group.hooks.filter((hook) => !isGuard(hook)) } : group))
      .filter((group) => !(group && typeof group === 'object' && Array.isArray(group.hooks)) || group.hooks.length);
    hooks[event] = [...kept, ...ours[event]];
  }
  return { ...settings, hooks };
}

/** Returns true when the settings file already carries the hooks of this installation. */
export function hooksInstalled(file = claudeSettingsPath()) {
  try {
    const settings = readSettings(file);
    // Hooks that are in the file and switched off as a whole protect nothing.
    if (settings.disableAllHooks === true) return false;
    return JSON.stringify(merged(settings)) === JSON.stringify(settings);
  } catch {
    return false;
  }
}

/** Returns true when the settings file carries guard hooks of any installation, current or not. */
export function hooksPresent(file = claudeSettingsPath()) {
  try {
    return Object.values(record(readSettings(file).hooks)).some((groups) => Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(isGuard)));
  } catch {
    return false;
  }
}

/** Merges the Codeignite hooks into the settings file and keeps every other hook. */
export function installHooks(file = claudeSettingsPath()) {
  const settings = readSettings(file);
  const next = merged(settings);
  if (JSON.stringify(next) === JSON.stringify(settings)) return { file, changed: false, backup: null };
  let backup = null;
  let mode = null;
  // A settings file that is a link to another place is written where it points, with the access it had.
  let target = file;
  if (fs.existsSync(file)) {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
    backup = `${file}.bak`;
    fs.copyFileSync(target, backup);
    fs.chmodSync(backup, mode);
  }
  writeJson(target, next);
  if (mode !== null) fs.chmodSync(target, mode);
  return { file, changed: true, backup };
}

const cli = () => `node ${quote(path.join(codeRoot(), 'bin', 'codeignite.mjs'))}`;
// Both files only point at "codeignite next"; stage content lives in the workflow definition.
const SKILL = () => `---
name: codeignite
description: Work on a Codeignite task, an issue or a pull-request review tracked by Codeignite on this machine. Use when a task id such as app-42 is named, when the session start lists Codeignite tasks in flight, or when the user says "Codeignite".
---

# Codeignite

The Codeignite CLI is \`${cli()}\`, written as \`codeignite\` below.

1. \`codeignite status\` lists the tasks in flight. \`codeignite next <id>\` prints the brief of the task's current stage.
2. Follow the brief. Read the files under "Read first". Invoke the skills and delegate to the agents it names. A "Read and follow <path>" line means: read that file in the task worktree and work by it.
3. Do the work inside the task worktree named in the brief, never in the main checkout.
4. Run \`codeignite advance <id>\`. Fix what it reports, then run \`codeignite next <id>\` for the next stage.

## Rules

- The brief is the instruction for the stage. Do not skip ahead of it.
- Never edit \`state.json\`, the \`evidence\` folder or \`verify.md\`. Only the CLI writes them.
- Never run the approve command and never open the Codeignite board. Approval belongs to the user.
- Never push, open a pull request or post a comment before the stage is \`approved\`.
- At \`ready\`, stop and tell the user what changed and how it was checked.
- Do not verify your own work. The verify stage goes to the agent the brief names.
- A line starting with \`MISSING:\` or \`BLOCKED:\` means stop and tell the user.
`;
const VERIFIER = () => `---
name: codeignite-verifier
description: Independent verifier for a Codeignite task at the verify stage. Re-runs the gates, checks the PR description against the diff, and records the verdict. Use it for the verify stage; it must not be the session that wrote the change.
tools: Read, Grep, Glob, Bash
---

You verify a Codeignite task that another agent implemented. Be skeptical: your job is to find what is wrong.

The Codeignite CLI is \`${cli()}\`, written as \`codeignite\` below.

1. Run \`codeignite next <id>\` and \`codeignite status <id>\`. Read the task's \`issue.md\`, \`plan.md\` and \`pr-body.md\` in the folder the brief names.
2. Re-run every gate yourself in the task worktree: \`codeignite run <id> <gate> --as verifier\`.
3. Read the diff against the base branch and judge two things separately, each in its own subagent with a fresh context when you can delegate:
   - Standards: does the diff follow this repository's documented rules (AGENTS.md, CONTRIBUTING.md, the coding guidelines)? Skip what the linter already enforces.
   - Intent: does the diff do what the issue asked, all of it and nothing beyond it?
   Then check every claim in \`pr-body.md\` against the code and by running it.
4. Write a report: each claim, how you checked it, the result. List findings with file:line.
5. Record the verdict: \`codeignite verdict <id> pass|fail --report <file>\`.

Never change code, commit, push, approve, or edit state and evidence files. A failed check is a \`fail\` verdict with the finding, not something to fix.
`;

/** Writes the Codeignite skill and the verifier agent into a Claude Code config folder. */
export function installAgentFiles(dir = path.dirname(claudeSettingsPath())) {
  const files = [[path.join(dir, 'skills', 'codeignite', 'SKILL.md'), SKILL()], [path.join(dir, 'agents', 'codeignite-verifier.md'), VERIFIER()]];
  return files.map(([file, text]) => {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return { file, changed: false, backup: null };
    let backup = null;
    if (fs.existsSync(file)) {
      backup = `${file}.bak`;
      fs.copyFileSync(file, backup);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return { file, changed: true, backup };
  });
}
