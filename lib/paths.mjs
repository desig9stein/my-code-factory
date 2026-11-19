// Source is portable; configuration and runtime data stay on this machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const codeRoot = () => path.resolve(here, '..');
export const factoryRoot = () => path.resolve(process.env.FACTORY_ROOT || path.join(os.homedir(), '.code-factory'));
export const configPath = () => path.join(factoryRoot(), 'config.json');
export function workspace() {
  if (process.env.FACTORY_WORKSPACE) return path.resolve(process.env.FACTORY_WORKSPACE);
  if (fs.existsSync(configPath())) {
    const config = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (config.workspace) return path.resolve(factoryRoot(), config.workspace);
  }
  return path.resolve(factoryRoot(), '..');
}
export const registryPath = () => path.join(factoryRoot(), 'repos.json');
export const issuesDir = () => path.join(factoryRoot(), 'issues');
export function issueDir(id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id || '')) throw new Error('Invalid issue id.');
  return path.join(issuesDir(), id);
}
export const evidenceDir = (id) => path.join(issueDir(id), 'evidence');
export const worktreesDir = () => path.join(factoryRoot(), 'worktrees');
export const workLogPath = () => path.join(workspace(), 'WORK_LOG.md');
export function within(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
