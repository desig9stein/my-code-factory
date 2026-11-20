// Generates the Claude Code hook settings and merges them into a settings file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeRoot, factoryRoot, workspace } from './paths.mjs';
// POSIX shell quoting; generated settings are local to this installation.
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const EVENTS = [['PreToolUse', 'pre'], ['PostToolUse', 'post'], ['SessionStart', 'session']];
// Matches a guard command of any factory installation.
const GUARD = /[\\/]bin[\\/]guard\.mjs'?\s+(pre|post|session)\s*$/;

export function hookSettings() {
  if (process.platform === 'win32') throw new Error('Hook command generation currently supports macOS/Linux shells. Configure your runner manually on Windows.');
  const command = mode => `FACTORY_ROOT=${quote(factoryRoot())} FACTORY_WORKSPACE=${quote(workspace())} ${quote(process.execPath)} ${quote(path.join(codeRoot(), 'bin', 'guard.mjs'))} ${mode}`;
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
  throw new Error(`${file} is not a JSON object. Fix it by hand, then run "factory hooks --install" again.`);
}

function merged(settings) {
  const ours = hookSettings().hooks;
  const hooks = { ...(settings.hooks || {}) };
  for (const [event] of EVENTS) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((hook) => !GUARD.test(hook.command || '')) }))
      .filter((group) => group.hooks.length);
    hooks[event] = [...kept, ...ours[event]];
  }
  return { ...settings, hooks };
}

/** Returns true when the settings file already carries the hooks of this installation. */
export function hooksInstalled(file = claudeSettingsPath()) {
  try {
    const settings = readSettings(file);
    return JSON.stringify(merged(settings)) === JSON.stringify(settings);
  } catch {
    return false;
  }
}

/** Merges the factory hooks into the settings file and keeps every other hook. */
export function installHooks(file = claudeSettingsPath()) {
  const settings = readSettings(file);
  const next = merged(settings);
  if (JSON.stringify(next) === JSON.stringify(settings)) return { file, changed: false, backup: null };
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak`;
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { file, changed: true, backup };
}
