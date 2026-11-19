import fs from 'node:fs';
import path from 'node:path';
import { configPath, factoryRoot, registryPath, workspace } from './paths.mjs';
import { loadRegistry } from './registry.mjs';
import { git, tryGit } from './sh.mjs';

const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
export function initialize(directory = process.cwd()) {
  const target = path.resolve(directory);
  if (!fs.statSync(target).isDirectory()) throw new Error('Workspace must be an existing directory.');
  fs.mkdirSync(factoryRoot(), { recursive: true });
  if (!fs.existsSync(configPath())) writeJson(configPath(), { version: 1, workspace: target });
  if (!fs.existsSync(registryPath())) writeJson(registryPath(), {
    defaults: { branchPattern: 'factory/{type}-{n}-{slug}', maxCommits: 3, testable: true, conventionalCommits: true, forbidAiAttribution: false },
    repos: {},
  });
  return { root: factoryRoot(), workspace: workspace() };
}
export function addProject(key, directory, options = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key || '')) throw new Error('Use letters, digits, dots, underscores or hyphens for the project key.');
  const dir = path.resolve(directory || '.');
  git(dir, 'rev-parse', '--show-toplevel');
  const registry = loadRegistry();
  if (Object.hasOwn(registry.repos, key)) throw new Error(`Project ${key} already exists. Edit repos.json to change it.`);
  const origin = tryGit(dir, 'remote', 'get-url', 'origin') || '';
  const remote = options.remote || /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin)?.[1];
  if (!/^[\w.-]+\/[\w.-]+$/.test(remote || '')) throw new Error('A GitHub origin or --remote owner/repo is required.');
  const base = options.base || tryGit(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')?.replace(/^origin\//, '') || tryGit(dir, 'branch', '--show-current');
  if (!base) throw new Error('Cannot infer a base branch. Supply --base main.');
  const repo = { dir: path.relative(workspace(), dir) || '.', remote, baseBranch: base,
    install: typeof options.install === 'string' ? options.install : '',
    gates: typeof options.verify === 'string' ? [{ name: 'verify', cmd: options.verify }] : [] };
  registry.repos[key] = repo;
  const tmp = `${registryPath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, registryPath());
  return repo;
}
