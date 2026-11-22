// Exports the workspace configuration as one portable file and applies such a file on another machine.
import { withSettings } from './lock.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pendingProjects, writeConfig } from './config.mjs';
import { workspace } from './paths.mjs';
import { getRepo, loadRegistry } from './registry.mjs';
import { checkGates, command, githubRemote, saveRegistry } from './setup.mjs';
import { checkWorkflow, inheritedWorkflow, saveWorkflow, workflowOverride } from './workflow.mjs';

const FORMAT = 1;
// Machine-local fields that never leave this computer.
// What an unattended agent may run is each person's own decision, so `agent` is not shared either.
const LOCAL_FIELDS = ['dir', 'dismissedProposals', 'agent'];
const DEFAULT_FIELDS = ['branchPattern', 'maxCommits', 'testable', 'conventionalCommits', 'forbidAiAttribution'];
// What a shared file may set on a project, and the kind of value each takes. Anything else in the file is left out:
// a field such as "dir" would point the project at a folder of the sender's choosing.
const text = (v) => typeof v === 'string' && v.length <= 4000 && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v);
const count = (v) => Number.isFinite(v) && v >= 0;
const flag = (v) => typeof v === 'boolean';
const names = (v) => Array.isArray(v) && v.length <= 100 && v.every((item) => typeof item === 'string' && item.length <= 200);
// Rules about the pull request text: a small object of lists and switches, never a command.
const rules = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length <= 8000 && Object.values(v).every((item) => names(item) || flag(item) || text(item) || count(item));
const wordsOrList = (v) => text(v) || names(v);
const PROJECT_FIELDS = { description: text, dependsOn: names, owns: wordsOrList, timeoutMinutes: count, prTemplate: text, prBody: rules, forbidAiAttribution: flag, trivialMaxFiles: count, testable: flag, maxCommits: count, conventionalCommits: flag, branchPattern: text };
const DEFAULT_KINDS = { branchPattern: text, maxCommits: count, testable: flag, conventionalCommits: flag, forbidAiAttribution: flag };
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const REMOTE = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[\w.-]+(\/[\w.-]+)*$/;

/** Returns the shareable configuration: defaults, projects and workflow, without paths or task data. */
export function exportConfig() {
  const registry = loadRegistry();
  const projects = {};
  for (const [key, entry] of Object.entries(registry.repos)) {
    const shared = Object.fromEntries(Object.entries(entry).filter(([field]) => !LOCAL_FIELDS.includes(field)));
    // The folder name is a hint; import finds the checkout by its GitHub remote.
    projects[key] = { folder: path.basename(getRepo(key, registry).dir), ...shared };
  }
  return { codeigniteConfig: FORMAT, defaults: registry.defaults || {}, workflow: workflowOverride('global', registry), projects };
}

// Finds the local checkout of a remote: the hinted folder first, then any repo in the workspace.
function findCheckout(remote, folder) {
  const matches = (dir) => fs.existsSync(path.join(dir, '.git')) && (githubRemote(dir) || '').toLowerCase() === remote.toLowerCase();
  const hinted = path.join(workspace(), folder);
  if (matches(hinted)) return hinted;
  const other = fs.readdirSync(workspace(), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(workspace(), e.name)).find(matches);
  return other || null;
}

function checkProject(key, input, types) {
  if (!KEY.test(key)) throw new Error(`Project key "${key}" is not valid. Use letters, digits, dots, underscores or hyphens.`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Project "${key}" must be an object.`);
  if (!REMOTE.test(input.remote || '')) throw new Error(`Project "${key}" needs "remote" as owner/repo, got ${JSON.stringify(input.remote)}.`);
  if (!BRANCH.test(input.baseBranch || '')) throw new Error(`Project "${key}" needs a "baseBranch" such as main, got ${JSON.stringify(input.baseBranch)}.`);
  const folder = String(input.folder || key);
  if (folder.includes('/') || folder.includes('\\') || folder.startsWith('.')) throw new Error(`Project "${key}" has folder ${JSON.stringify(folder)}; it must be a folder name inside the workspace, without a path.`);
  const { workflow, gates, install, setup, teardown } = input;
  const rest = { remote: input.remote, baseBranch: input.baseBranch };
  for (const [field, fits] of Object.entries(PROJECT_FIELDS)) {
    if (!Object.hasOwn(input, field) || input[field] === null) continue;
    if (!fits(input[field])) throw new Error(`Project "${key}" has "${field}" as ${JSON.stringify(input[field]).slice(0, 80)}, which is not a value that field takes.`);
    rest[field] = input[field];
  }
  return { folder, entry: { ...rest, install: command(install ?? '', `The install command of "${key}"`), ...(setup ? { setup: command(setup, `The setup command of "${key}"`) } : {}), ...(teardown ? { teardown: command(teardown, `The teardown command of "${key}"`) } : {}), gates: gates ?? [], ...(workflow ? { workflow: checkWorkflow(workflow, types) } : {}) } };
}

/**
 * Validates a shared configuration and returns what applying it would do, per project:
 * add, update, same, or missing (no local checkout). Nothing is written.
 */
export function planImport(data) {
  // A file exported before the rename carries the format under its earlier key.
  if (!data || typeof data !== 'object' || (data.codeigniteConfig ?? data.factoryConfig) !== FORMAT) throw new Error(`This is not a Codeignite configuration file of format ${FORMAT}. Create one with "codeignite export <file>".`);
  const unknown = Object.keys(data).find((field) => !['codeigniteConfig', 'factoryConfig', 'defaults', 'workflow', 'projects'].includes(field));
  if (unknown) throw new Error(`"${unknown}" is not a field of a Codeignite configuration file.`);
  const registry = loadRegistry();
  const workflow = checkWorkflow(data.workflow || {});
  const types = workflow.types || inheritedWorkflow('global').types;
  const defaults = Object.fromEntries(Object.entries(data.defaults && typeof data.defaults === 'object' ? data.defaults : {}).filter(([field]) => DEFAULT_FIELDS.includes(field)));
  for (const [field, value] of Object.entries(defaults)) if (!DEFAULT_KINDS[field](value)) throw new Error(`The default "${field}" is ${JSON.stringify(value).slice(0, 80)}, which is not a value that field takes.`);
  const projects = Object.entries(data.projects || {}).map(([key, input]) => {
    const { folder, entry } = checkProject(key, input, types);
    const dir = findCheckout(entry.remote, folder);
    if (!dir) return { key, status: 'missing', remote: entry.remote, folder, entry, dir: null };
    entry.gates = checkGates(dir, entry.gates);
    const next = { ...entry, dir: path.relative(workspace(), dir) || '.' };
    const current = registry.repos[key];
    const comparable = current && Object.fromEntries(Object.entries(current).filter(([field]) => !['dismissedProposals', 'agent'].includes(field)));
    const status = !current ? 'add' : JSON.stringify(Object.entries(comparable).sort()) === JSON.stringify(Object.entries(next).sort()) ? 'same' : 'update';
    return { key, status, remote: entry.remote, folder, entry: next, dir };
  });
  return { defaults, workflow, projects };
}

/** Applies a plan from planImport and returns it. Projects without a checkout are left out. */
export const applyImport = (plan) => withSettings(() => applyImportNow(plan));

function applyImportNow(plan) {
  const registry = loadRegistry();
  registry.defaults = { ...registry.defaults, ...plan.defaults };
  for (const project of plan.projects) {
    if (project.status === 'missing') continue;
    const { dismissedProposals: dismissed, agent } = registry.repos[project.key] || {};
    registry.repos[project.key] = { ...project.entry, ...(dismissed ? { dismissedProposals: dismissed } : {}), ...(agent ? { agent } : {}) };
  }
  saveRegistry(registry);
  saveWorkflow('global', plan.workflow);
  // Settings of projects without a checkout wait, and apply when the project is added from any folder.
  const waiting = { ...pendingProjects() };
  for (const project of plan.projects) {
    if (project.status === 'missing') waiting[project.key] = project.entry;
    else delete waiting[project.key];
  }
  writeConfig({ pendingProjects: waiting });
  return plan;
}
