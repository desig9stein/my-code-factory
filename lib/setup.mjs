// Initializes the data directory, discovers projects and validates registry edits.
import { commandLinked, commandText } from './cli.mjs';
import { withSettings } from './lock.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentSettings, checkProjectAgent } from './agents.mjs';
import { harness } from './harnesses.mjs';
import { pendingFor, pendingProjects, writeConfig } from './config.mjs';
import { codeRoot, configPath, factoryRoot, registryPath, within, workspace } from './paths.mjs';
import { getRepo, loadRegistry } from './registry.mjs';
import { git, run, tryGit } from './sh.mjs';
import { listStates } from './state.mjs';
import { writeJson } from './store.mjs';

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const BRANCH = /^[\w.-]+(\/[\w.-]+)*$/;
const GATE_NAME = /^[a-z0-9][a-z0-9-]*$/;
// Names "codeignite run" and "codeignite note" already give another meaning.
const RESERVED_GATES = ['install', 'reproduce', 'regress'];
const EDITABLE = ['baseBranch', 'install', 'gates', 'agent'];
const MAX_GATES = 10;
const MAX_COMMAND = 500;

// Creates a file and refuses to replace one: setup never overwrites existing settings.
const createJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
export function initialize(directory = process.cwd()) {
  const target = path.resolve(directory);
  if (!fs.statSync(target).isDirectory()) throw new Error('Workspace must be an existing directory.');
  fs.mkdirSync(factoryRoot(), { recursive: true });
  if (!fs.existsSync(configPath())) createJson(configPath(), { version: 1, workspace: target });
  if (!fs.existsSync(registryPath())) createJson(registryPath(), {
    defaults: { branchPattern: 'codeignite/{type}-{n}-{slug}', maxCommits: 3, testable: true, conventionalCommits: true, forbidAiAttribution: false },
    repos: {},
  });
  return { root: factoryRoot(), workspace: workspace() };
}

/** Writes repos.json through a temporary file, so a reader never sees half of it. */
export function saveRegistry(registry) {
  writeJson(registryPath(), registry);
}

export const githubRemote = (dir) => /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(tryGit(dir, 'remote', 'get-url', 'origin') || '')?.[1] || null;
const originHead = (dir) => tryGit(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')?.replace(/^origin\//, '') || null;

export function command(value, what) {
  if (typeof value !== 'string') throw new Error(`${what} must be text, got ${JSON.stringify(value)}.`);
  const text = value.trim();
  if (/[\r\n]/.test(text)) throw new Error(`${what} must be one line. Join steps with "&&".`);
  if (text.length > MAX_COMMAND) throw new Error(`${what} is ${text.length} characters; the limit is ${MAX_COMMAND}. Move long commands into a package script.`);
  return text;
}

export function checkGates(dir, gates) {
  if (!Array.isArray(gates)) throw new Error('gates must be a list of { name, cmd }.');
  if (gates.length > MAX_GATES) throw new Error(`${gates.length} gates given; the limit is ${MAX_GATES}. Combine related checks in one command.`);
  const seen = new Set();
  return gates.map((gate, index) => {
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) throw new Error(`Gate ${index + 1} must be { name, cmd }.`);
    const extra = Object.keys(gate).find((k) => !['name', 'cmd', 'cwd'].includes(k));
    if (extra) throw new Error(`Gate ${index + 1} has an unknown field "${extra}". Valid fields: name, cmd, cwd.`);
    const name = String(gate.name ?? '').trim();
    if (!GATE_NAME.test(name)) throw new Error(`Gate name "${name}" is not valid. Use lowercase letters, digits and hyphens, for example "lint" or "test-chrome".`);
    if (RESERVED_GATES.includes(name)) throw new Error(`Gate name "${name}" is reserved by the Codeignite CLI. Pick another name, for example "verify".`);
    if (seen.has(name)) throw new Error(`Gate name "${name}" is used twice. Every gate needs its own name.`);
    seen.add(name);
    const cmd = command(gate.cmd, `The command of gate "${name}"`);
    if (!cmd) throw new Error(`Gate "${name}" has no command. Enter one, or remove the gate.`);
    const out = { name, cmd };
    if (gate.cwd !== undefined && gate.cwd !== '') {
      if (typeof gate.cwd !== 'string' || !within(path.resolve(dir, gate.cwd), dir)) throw new Error(`The cwd of gate "${name}" must be a folder inside the project, got ${JSON.stringify(gate.cwd)}.`);
      out.cwd = gate.cwd;
    }
    return out;
  });
}

function checkBase(dir, value) {
  const base = String(value ?? '').trim();
  if (!BRANCH.test(base)) throw new Error(`Base branch "${base}" is not a branch name. Example: main, vnext, release/2.x.`);
  if (!tryGit(dir, 'rev-parse', '--verify', '--quiet', `origin/${base}`)) throw new Error(`origin/${base} does not exist in ${dir}. Run "git fetch origin ${base}" there, or pick an existing branch.`);
  return base;
}

/** Returns the registration a project folder gets when nothing is specified. */
export function suggestProject(directory) {
  const dir = path.resolve(directory);
  const has = (file) => fs.existsSync(path.join(dir, file));
  let scripts = {};
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
  } catch { /* A folder without a readable package.json gets no npm suggestions. */ }
  const install = has('yarn.lock') ? 'yarn install --frozen-lockfile' : has('pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile' : has('package-lock.json') ? 'npm ci' : '';
  const call = (script) => (script === 'test' ? 'npm test' : `npm run ${script}`);
  const checks = ['lint', 'test'].filter((script) => scripts[script]);
  const cmd = scripts.verify ? call('verify') : checks.length ? checks.map(call).join(' && ') : scripts.build ? call('build') : '';
  const remote = githubRemote(dir);
  const guess = {
    key: path.basename(dir).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, ''),
    dir,
    remote,
    baseBranch: originHead(dir) || tryGit(dir, 'branch', '--show-current') || null,
    install,
    gates: cmd ? [{ name: 'verify', cmd }] : [],
    shared: false,
  };
  // Settings a teammate shared for this repository win over the guess.
  const waiting = remote ? pendingFor(remote) : null;
  return waiting ? { ...guess, key: waiting[0], baseBranch: waiting[1].baseBranch, install: waiting[1].install ?? '', gates: waiting[1].gates || [], shared: true } : guess;
}

/** Lists the GitHub repositories directly inside the workspace that are not registered. */
export function discoverProjects() {
  const registry = loadRegistry();
  const registered = new Set(Object.keys(registry.repos).map((key) => getRepo(key, registry).dir));
  return fs.readdirSync(workspace(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(workspace(), entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, '.git')) && !registered.has(dir) && !within(dir, factoryRoot()))
    .map(suggestProject)
    .filter((project) => project.key && project.remote && project.baseBranch)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Checks a folder someone typed and returns the registration it would get. The folder may lie
 * outside the workspace; "~" stands for the home folder.
 */
export function locateProject(input) {
  const typed = String(input ?? '').trim();
  if (!typed) throw new Error('Enter the folder of a Git repository, for example ~/code/my-app.');
  const dir = path.resolve(workspace(), typed === '~' || typed.startsWith('~/') ? path.join(os.homedir(), typed.slice(1)) : typed);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder on this machine. Check the path.`);
  const top = tryGit(dir, 'rev-parse', '--show-toplevel');
  if (!top) throw new Error(`${dir} is not a Git repository. Clone the project first, then enter its folder.`);
  if (fs.realpathSync(top) !== fs.realpathSync(dir)) throw new Error(`${dir} is a folder inside a repository. Enter the repository root: ${top}`);
  const registry = loadRegistry();
  const taken = Object.keys(registry.repos).find((key) => fs.existsSync(getRepo(key, registry).dir) && fs.realpathSync(getRepo(key, registry).dir) === fs.realpathSync(dir));
  if (taken) throw new Error(`${dir} is already registered as "${taken}".`);
  const found = suggestProject(dir);
  if (!found.remote) throw new Error(`${dir} has no GitHub origin. Codeignite takes tasks from GitHub issues, so the repository needs an origin on github.com.`);
  if (!found.baseBranch) throw new Error(`The base branch of ${dir} cannot be worked out. Run "git remote set-head origin --auto" there, or register it with "codeignite add <key> <directory> --base <branch>".`);
  let key = found.key || 'project';
  for (let n = 2; Object.hasOwn(registry.repos, key); n++) key = `${found.key}-${n}`;
  return { ...found, key, outside: !within(dir, workspace()) };
}

export const addProject = (key, directory, options = {}) => withSettings(() => addProjectNow(key, directory, options));

function addProjectNow(key, directory, options = {}) {
  if (!KEY.test(key || '')) throw new Error('Use letters, digits, dots, underscores or hyphens for the project key.');
  const dir = path.resolve(directory || '.');
  git(dir, 'rev-parse', '--show-toplevel');
  const registry = loadRegistry();
  if (Object.hasOwn(registry.repos, key)) throw new Error(`Project ${key} already exists. Edit it on the Projects page of the board, or in repos.json.`);
  const suggested = suggestProject(dir);
  const remote = options.remote || suggested.remote;
  if (!/^[\w.-]+\/[\w.-]+$/.test(remote || '')) throw new Error('A GitHub origin or --remote owner/repo is required.');
  const base = options.base || suggested.baseBranch;
  if (!base) throw new Error('Cannot infer a base branch. Supply --base main.');
  if (!BRANCH.test(base)) throw new Error(`Base branch "${base}" is not a branch name. Example: main, vnext, release/2.x.`);
  const gates = Array.isArray(options.gates) ? options.gates : typeof options.verify === 'string' ? [{ name: 'verify', cmd: options.verify }] : suggested.gates;
  // A project inside the workspace keeps a relative path, so the registry moves with the workspace.
  const repo = { dir: within(dir, workspace()) ? path.relative(workspace(), dir) || '.' : dir, remote, baseBranch: base,
    install: command(typeof options.install === 'string' ? options.install : suggested.install, 'The install command'),
    gates: checkGates(dir, gates) };
  if (typeof options.description === 'string') repo.description = options.description;
  if (typeof options['depends-on'] === 'string') {
    repo.dependsOn = options['depends-on'].split(',').map((k) => k.trim()).filter(Boolean);
    const unknown = repo.dependsOn.filter((k) => !Object.hasOwn(registry.repos, k));
    if (unknown.length) throw new Error(`--depends-on names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not registered. Register the project it depends on first.`);
  }
  // The rest of a shared setup (PR rules, workflow) comes along; what was just confirmed wins.
  const waiting = pendingFor(remote);
  registry.repos[key] = waiting ? { ...waiting[1], ...repo } : repo;
  saveRegistry(registry);
  if (waiting) {
    const { [waiting[0]]: _applied, ...rest } = pendingProjects();
    writeConfig({ pendingProjects: rest });
  }
  return registry.repos[key];
}

/** Changes the base branch, install command, gates or agent settings of a registered project. */
export const updateProject = (key, patch = {}) => withSettings(() => updateProjectNow(key, patch));

function updateProjectNow(key, patch = {}) {
  const registry = loadRegistry();
  if (!Object.hasOwn(registry.repos, key)) throw new Error(`Unknown project "${key}". Registered: ${Object.keys(registry.repos).join(', ') || 'none'}.`);
  const unknown = Object.keys(patch).find((field) => !EDITABLE.includes(field));
  if (unknown) throw new Error(`"${unknown}" cannot be changed here. Editable fields: ${EDITABLE.join(', ')}. Edit repos.json for the rest.`);
  const { dir } = getRepo(key, registry);
  const entry = registry.repos[key];
  if (patch.baseBranch !== undefined) {
    entry.baseBranch = checkBase(dir, patch.baseBranch);
    // Records a deliberate choice, so "codeignite doctor" does not report it as drift.
    if (entry.baseBranch === originHead(dir)) delete entry.allowBaseMismatch;
    else entry.allowBaseMismatch = true;
  }
  if (patch.install !== undefined) entry.install = command(patch.install, 'The install command');
  if (patch.gates !== undefined) entry.gates = checkGates(dir, patch.gates);
  if (patch.agent !== undefined) {
    const agent = checkProjectAgent(patch.agent);
    if (Object.keys(agent).length) entry.agent = agent;
    else delete entry.agent;
  }
  saveRegistry(registry);
  return entry;
}

/** Removes a project from the registry; its folder and task history stay. */
export const removeProject = (key) => withSettings(() => removeProjectNow(key));

function removeProjectNow(key) {
  const registry = loadRegistry();
  if (!Object.hasOwn(registry.repos, key)) throw new Error(`Unknown project "${key}". Registered: ${Object.keys(registry.repos).join(', ') || 'none'}.`);
  const tasks = listStates().filter((state) => state.repo === key).map((state) => state.id);
  if (tasks.length) throw new Error(`${key} has tasks in flight: ${tasks.join(', ')}. Archive them first, then remove the project.`);
  delete registry.repos[key];
  saveRegistry(registry);
}

/** Checks the tools Codeignite needs; a failed required check stops setup. */
export function preflight() {
  const version = (cmd) => {
    const r = run(cmd, ['--version']);
    return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
  };
  const node = Number(process.versions.node.split('.')[0]);
  const gitVersion = version('git');
  const ghVersion = version('gh');
  const login = ghVersion ? run('gh', ['auth', 'status']).status === 0 : false;
  const tool = harness(agentSettings().harness);
  const toolVersion = tool.version();
  return [
    { name: 'Node.js 22 or newer', ok: node >= 22, required: true, detail: `v${process.versions.node}`, fix: 'Install Node.js 22 or newer from https://nodejs.org.' },
    { name: 'Git', ok: Boolean(gitVersion), required: true, detail: gitVersion, fix: 'Install Git from https://git-scm.com.' },
    { name: 'GitHub CLI', ok: Boolean(ghVersion), required: false, detail: ghVersion, fix: 'Install it from https://cli.github.com. Task intake and the GitHub issues view need it.' },
    { name: 'GitHub CLI login', ok: login, required: false, detail: login ? 'logged in' : null, fix: 'Run "gh auth login".' },
    { name: 'The "codeignite" command', ok: commandLinked(), required: false, detail: commandLinked() ? 'on your PATH' : null, fix: `Run "npm link" in ${codeRoot()} to type "codeignite" (short: "cig"). Until then every command works as: ${commandText()} <command>` },
    { name: `${tool.label}, to run agents from the board`, ok: Boolean(toolVersion), required: false, detail: toolVersion, fix: tool.install },
  ];
}
