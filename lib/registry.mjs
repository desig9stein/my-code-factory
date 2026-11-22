// Loads repos.json and resolves one repo entry with the defaults applied.
import fs from 'node:fs';
import path from 'node:path';
import { registryPath, workspace } from './paths.mjs';

export function loadRegistry() {
  const file = registryPath();
  if (!fs.existsSync(file)) throw new Error(`Registry not found at ${file}. Run "codeignite setup --workspace <directory>" first.`);
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Fix the file; nothing was changed.`);
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error(`${file} must hold an object with a "repos" entry.`);
  if (!registry.repos || typeof registry.repos !== 'object' || Array.isArray(registry.repos)) registry.repos = {};
  return registry;
}

/** Returns the repo entry merged over the registry defaults. */
export function getRepo(key, registry = loadRegistry()) {
  // Only a project of its own: "constructor" and the like are names every object answers to.
  const entry = typeof key === 'string' && Object.hasOwn(registry.repos, key) ? registry.repos[key] : null;
  if (!entry || typeof entry !== 'object') {
    const known = Object.keys(registry.repos);
    throw new Error(`Unknown repo "${key}". Valid repos: ${known.slice(0, 12).join(', ') || 'none'}${known.length > 12 ? `, and ${known.length - 12} more` : ''}.`);
  }
  const repo = { ...registry.defaults, ...entry, key };
  repo.dir = path.resolve(workspace(), entry.dir || key);
  repo.gates = Array.isArray(entry.gates) ? entry.gates.filter((g) => g && typeof g.name === 'string' && typeof g.cmd === 'string') : [];
  return repo;
}

/** Splits "astro-components#196" into its repo key and issue number. */
export function parseRef(ref) {
  const m = /^(.+)#(\d+)$/.exec(ref || '');
  if (!m) throw new Error(`Expected <repo>#<number>, got "${ref}". Example: app#42.`);
  const issue = Number(m[2]);
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error(`"${m[2]}" is not an issue number. Example: app#42.`);
  return { repo: m[1], issue };
}
