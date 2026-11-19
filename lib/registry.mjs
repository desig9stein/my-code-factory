// Loads repos.json and resolves one repo entry with the defaults applied.
import fs from 'node:fs';
import path from 'node:path';
import { registryPath, workspace } from './paths.mjs';

export function loadRegistry() {
  const file = registryPath();
  if (!fs.existsSync(file)) throw new Error(`Registry not found at ${file}. Run "factory init --workspace <directory>" first.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Returns the repo entry merged over the registry defaults. */
export function getRepo(key, registry = loadRegistry()) {
  const entry = registry.repos[key];
  if (!entry) {
    throw new Error(`Unknown repo "${key}". Valid repos: ${Object.keys(registry.repos).join(', ')}.`);
  }
  const repo = { ...registry.defaults, ...entry, key };
  repo.dir = path.resolve(workspace(), entry.dir || key);
  repo.gates = entry.gates || [];
  return repo;
}

/** Splits "astro-components#196" into its repo key and issue number. */
export function parseRef(ref) {
  const m = /^(.+)#(\d+)$/.exec(ref || '');
  if (!m) throw new Error(`Expected <repo>#<number>, got "${ref}". Example: app#42.`);
  return { repo: m[1], issue: Number(m[2]) };
}

/** Splits an issue id such as "app-42". */
export function parseId(id) {
  const m = /^(.+)-(\d+)$/.exec(id || '');
  if (!m) throw new Error(`Expected an issue id like app-42, got "${id}".`);
  return { repo: m[1], issue: Number(m[2]) };
}
