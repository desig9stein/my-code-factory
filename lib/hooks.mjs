import path from 'node:path';
import { codeRoot, factoryRoot, workspace } from './paths.mjs';
// POSIX shell quoting; generated settings are local to this installation.
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export function hookSettings() {
  if (process.platform === 'win32') throw new Error('Hook command generation currently supports macOS/Linux shells. Configure your runner manually on Windows.');
  const command = mode => `FACTORY_ROOT=${quote(factoryRoot())} FACTORY_WORKSPACE=${quote(workspace())} ${quote(process.execPath)} ${quote(path.join(codeRoot(), 'bin', 'guard.mjs'))} ${mode}`;
  return { hooks: Object.fromEntries([['PreToolUse', 'pre'], ['PostToolUse', 'post'], ['SessionStart', 'session']].map(([event, mode]) => [event, [{ matcher: '', hooks: [{ type: 'command', command: command(mode) }] }]])) };
}
