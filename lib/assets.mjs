// Finds the skills, agents, instruction files and PR template a project already has, and proposes how to use them.
import { withSettings } from './lock.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, writeConfig } from './config.mjs';
import { RECOMMENDED } from './recommended.mjs';
import { getRepo, loadRegistry } from './registry.mjs';
import { saveRegistry, updateProject } from './setup.mjs';
import { resolveWorkflow, saveWorkflow, stageTitle, workflowOverride } from './workflow.mjs';

// Ordered by preference: Claude Code invokes only what lives under .claude.
const SKILL_DIRS = ['.claude/skills', '.agents/skills', '.github/skills'];
const AGENT_DIRS = ['.claude/agents', '.agents/agents', '.github/agents'];
const PRODUCT_DIR = 'skills';
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GLOSSARY.md', 'CONTEXT.md', '.claude/CLAUDE.md', '.github/copilot-instructions.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md'];
// A glossary gives the agent the project's own words, so it reads it before every step too.
const READ_FIRST = ['AGENTS.md', 'CLAUDE.md', 'GLOSSARY.md', 'CONTEXT.md'];
const EVIDENCE = 'Evidence';
const GATE_SCRIPT = /^(lint|test|check|verify|build|format:check|typecheck)(:(?!watch$|fix$)[\w.-]+)?$/;

// First match wins. `also` adds a second proposal for the same asset.
const RULES = [
  { test: /orchestrator|triage/, stage: 'triage' },
  { test: /tdd|test-writer/, stage: 'implement' },
  { test: /implement|apply-change/, stage: 'implement' },
  { test: /review/, pipeline: 'review', stage: 'draft', also: { pipeline: 'stages', stage: 'verify' } },
  { test: /verify|ship/, stage: 'gates' },
  { test: /changelog|explore|new-change/, stage: 'plan' },
];

// Reads "name" and "description" from YAML front matter; folded and quoted values included.
function frontMatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const out = {};
  if (!block) return out;
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (/^[>|][+-]?$/.test(value) || value === '') {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    out[m[1]] = value.replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  }
  return out;
}

const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []);

function collect(root, dirs, kind, files) {
  const byName = new Map();
  for (const dir of dirs) {
    for (const file of files(path.join(root, dir))) {
      const text = fs.readFileSync(path.join(root, dir, file), 'utf8');
      const meta = frontMatter(text);
      const name = meta.name || (path.basename(file) === 'SKILL.md' ? path.basename(path.dirname(file)) : path.basename(file, '.md'));
      const copy = { path: path.posix.join(dir, file.split(path.sep).join('/')), hash: digest(text) };
      const known = byName.get(name);
      if (known) {
        known.copies.push(copy.path);
        if (copy.hash !== known.hash) known.differs = true;
        continue;
      }
      const invocable = dir.startsWith('.claude/');
      byName.set(name, { kind, name, description: (meta.description || '').slice(0, 400), path: copy.path, ref: invocable ? name : copy.path, invocable, copies: [copy.path], differs: false, hash: copy.hash });
    }
  }
  return [...byName.values()].map(({ hash, ...asset }) => asset).sort((a, b) => a.name.localeCompare(b.name));
}

const skillFiles = (dir) => list(dir).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))).map((e) => path.join(e.name, 'SKILL.md'));
const agentFiles = (dir) => list(dir).filter((e) => e.isFile() && e.name.endsWith('.md') && !/^readme\.md$/i.test(e.name)).map((e) => e.name);

// Finds the "skills" folders of plugins synced from claude.ai; the folder above each one names the plugin.
function pluginSkillDirs(dir, depth = 0, out = []) {
  if (depth > 6 || out.length > 80) return out;
  for (const entry of list(dir)) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'skills') out.push(full);
    else pluginSkillDirs(full, depth + 1, out);
  }
  return out;
}

// Finds every SKILL.md below a folder; plugins group skills in category folders.
function skillFilesDeep(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  for (const entry of list(dir)) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (fs.existsSync(path.join(full, 'SKILL.md'))) out.push(path.join(full, 'SKILL.md'));
    else skillFilesDeep(full, depth + 1, out);
  }
  return out;
}

// Returns [plugin name, SKILL.md path] for the plugins Claude Code lists as installed.
function installedPluginSkills(dir) {
  let index = {};
  try {
    index = JSON.parse(fs.readFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch { /* No plugin was installed through Claude Code. */ }
  const out = [];
  for (const [id, value] of Object.entries(index.plugins || {})) {
    const root = (Array.isArray(value) ? value[0] : value)?.installPath;
    if (typeof root !== 'string' || !fs.existsSync(root)) continue;
    const plugin = id.split('@')[0];
    let declared = null;
    try {
      declared = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).skills;
    } catch { /* A plugin without a manifest exposes every skill it carries. */ }
    // A manifest that lists its skills leaves the others out on purpose.
    const files = Array.isArray(declared) ? declared.map((entry) => path.join(root, String(entry), 'SKILL.md')).filter((file) => fs.existsSync(file) && file.startsWith(root)) : skillFilesDeep(path.join(root, 'skills'));
    for (const file of files) out.push([plugin, file]);
  }
  return out;
}

/** Returns the user's own skills and agents, including plugin skills, with their descriptions. */
export function userAssets() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const describe = (file, name) => ({ name, description: (frontMatter(fs.readFileSync(file, 'utf8')).description || '').slice(0, 400) });
  const skills = new Map();
  const add = (name, file) => { if (!skills.has(name)) skills.set(name, describe(file, name)); };
  for (const file of skillFiles(path.join(dir, 'skills'))) add(path.dirname(file), path.join(dir, 'skills', file));
  for (const [plugin, file] of installedPluginSkills(dir)) add(`${plugin}:${path.basename(path.dirname(file))}`, file);
  for (const folder of pluginSkillDirs(path.join(dir, 'plugins', 'synced'))) {
    // A folder such as "design~g2" is another installed copy of the plugin "design".
    const plugin = path.basename(path.dirname(folder)).replace(/~.*$/, '');
    for (const file of skillFiles(folder)) add(`${plugin}:${path.dirname(file)}`, path.join(folder, file));
  }
  const agents = agentFiles(path.join(dir, 'agents')).map((file) => describe(path.join(dir, 'agents', file), path.basename(file, '.md')));
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { skills: [...skills.values()].sort(byName).slice(0, 400), agents: agents.sort(byName) };
}

/** Returns what a project folder already carries for agents: skills, agents, instruction files, PR template. */
export function discoverAssets(dir) {
  const root = path.resolve(dir);
  const instructions = INSTRUCTION_FILES.filter((file) => fs.existsSync(path.join(root, file)));
  for (const entry of list(path.join(root, '.github/instructions'))) if (entry.isFile() && entry.name.endsWith('.md')) instructions.push(`.github/instructions/${entry.name}`);
  const template = list(path.join(root, '.github')).find((e) => e.isFile() && /^pull_request_template\.md$/i.test(e.name));
  return {
    skills: collect(root, SKILL_DIRS, 'skill', skillFiles),
    agents: collect(root, AGENT_DIRS, 'agent', agentFiles),
    products: collect(root, [PRODUCT_DIR], 'product', skillFiles),
    instructions,
    prTemplate: template ? `.github/${template.name}` : null,
  };
}

function templateSections(root, file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  return [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].replace(/[*_`]/g, '').replace(/:$/, '').trim()).filter(Boolean).slice(0, 12);
}

// Finds package scripts the instruction files tell contributors to run.
function namedScripts(root, instructions) {
  let scripts = {};
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
  } catch { /* A project without a readable package.json has no script proposals. */ }
  const text = instructions.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const found = new Set();
  for (const m of text.matchAll(/\bnpm (?:run )?([\w:.-]+)/g)) if (scripts[m[1]] && GATE_SCRIPT.test(m[1])) found.add(m[1]);
  for (const m of text.matchAll(/`([\w:.-]+)`/g)) if (scripts[m[1]] && GATE_SCRIPT.test(m[1])) found.add(m[1]);
  return [...found].slice(0, 6);
}

/**
 * Returns proposals for a project: stage assignments for its skills and agents, files to read first,
 * PR sections and gates. Proposals already in effect or dismissed are left out.
 */
export function proposeForProject(key, registry = loadRegistry()) {
  const repo = getRepo(key, registry);
  const assets = discoverAssets(repo.dir);
  const workflow = resolveWorkflow(key, registry);
  const dismissed = new Set(registry.repos[key].dismissedProposals || []);
  const proposals = [];
  const add = (proposal) => { if (!dismissed.has(proposal.id)) proposals.push(proposal); };

  for (const asset of [...assets.agents, ...assets.skills]) {
    const rule = RULES.find((r) => r.test.test(asset.name));
    if (!rule) continue;
    const types = ['bug', 'feature'].filter((type) => asset.name.includes(type === 'bug' ? 'bug' : 'feature') && workflow.types.includes(type));
    for (const target of [rule, rule.also].filter(Boolean)) {
      const pipeline = target.pipeline || 'stages';
      if (workflow[pipeline][target.stage].use.some((entry) => entry.ref === asset.ref)) continue;
      add({
        id: `use:${pipeline}:${target.stage}:${asset.ref}`,
        action: 'use',
        pipeline,
        stage: target.stage,
        use: { ref: asset.ref, kind: asset.kind, ...(types.length ? { types } : {}) },
        title: `Use ${asset.kind} "${asset.name}" at ${pipeline === 'review' ? 'review ' : ''}${target.stage}${types.length ? ` for ${types.join(', ')}` : ''}`,
        reason: asset.description || asset.path,
        effect: `When ${pipeline === 'review' ? 'a pull request review' : types.length ? `a ${types.join(' or ')} task` : 'a task'} of ${key} reaches the "${pipeline === 'review' ? target.stage : stageTitle(workflow, target.stage)}" step, the agent is told to ${asset.invocable ? `${asset.kind === 'agent' ? 'delegate to the agent' : 'invoke the skill'} "${asset.name}"` : `read ${asset.path} and work by it`}, in addition to the step's instructions.${types.length ? ' Other task types are not affected.' : ''} No file in the repository changes.`,
        undo: `Open the ${pipeline === 'review' ? 'review ' : ''}"${pipeline === 'review' ? target.stage : stageTitle(workflow, target.stage)}" step for ${key} and remove it under "Skills and agents".`,
        note: asset.differs ? `Copies differ: ${asset.copies.join(', ')}. This uses ${asset.path}.` : '',
      });
    }
  }

  const readFirst = READ_FIRST.filter((file) => assets.instructions.includes(file) && !workflow.readFirst.includes(file));
  if (readFirst.length) add({ id: `readFirst:${readFirst.join(',')}`, action: 'readFirst', files: readFirst, title: `Tell the agent to read ${readFirst.join(' and ')} first`, reason: `${readFirst.join(' and ')} ${readFirst.length === 1 ? 'holds' : 'hold'} this repository's rules for agents.`, effect: `Every step of every ${key} task starts with "Read first: ${readFirst.join(', ')}", so the agent reads ${readFirst.length === 1 ? 'that file' : 'those files'} before it follows the step's instructions.`, undo: `Open "Settings for every step" for ${key} and remove the file.`, note: '' });

  if (assets.prTemplate) {
    const sections = templateSections(repo.dir, assets.prTemplate);
    const current = (registry.repos[key].prBody?.requiredSections || []).filter((name) => name !== EVIDENCE);
    if (sections.length && JSON.stringify(sections) !== JSON.stringify(current)) add({ id: `prBody:${digest(sections.join('|')).slice(0, 8)}`, action: 'prBody', sections, title: `Require the PR template sections: ${sections.join(', ')}`, reason: `These are the headings of ${assets.prTemplate}.`, effect: `A ${key} task cannot pass the "verify" step until its PR description has every one of these sections filled in. An empty one, or "N/A", is rejected.${current.length ? ` This replaces the sections required today: ${current.join(', ')}.` : ''}`, undo: 'Edit "prBody.requiredSections" for the project in repos.json; the board cannot change it yet.', note: sections.some((name) => /screenshot|recording|checklist/i.test(name)) ? 'Some of these sections are optional in most pull requests (screenshots, checklist). Requiring them means every task must fill them in.' : '' });
  }

  if (!(registry.repos[key].prBody?.requiredSections || []).some((name) => /evidence/i.test(name)) && !(assets.prTemplate && templateSections(repo.dir, assets.prTemplate).some((name) => /evidence|tested|testing|how to test/i.test(name)))) {
    add({ id: 'prEvidence', action: 'prEvidence', title: 'Require an "Evidence" section in PR descriptions', reason: 'Before and after output, or a failing and a passing test run, lets a reviewer see the change work without running it.', effect: `A ${key} task cannot pass the "verify" step until its PR description has a filled-in "## Evidence" section.`, undo: 'Edit "prBody.requiredSections" for the project in repos.json; the board cannot change it yet.', note: '' });
  }

  const gated = repo.gates.map((gate) => gate.cmd).join(' ; ');
  for (const script of namedScripts(repo.dir, assets.instructions)) {
    const cmd = script === 'test' ? 'npm test' : `npm run ${script}`;
    const name = script.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (new RegExp(`(^|[\\s;&])${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s;&])`).test(gated) || repo.gates.some((gate) => gate.name === name)) continue;
    add({ id: `gate:${name}`, action: 'gate', gate: { name, cmd }, title: `Add gate "${name}": ${cmd}`, reason: 'The project instructions name this script and no gate runs it yet.', effect: `Every ${key} task must pass "${cmd}" at the "gates" step, and the verifier runs it again. Tasks already past that step go back to it and need this run too.`, undo: `Open Projects, edit ${key}, and remove the gate "${name}".`, note: '' });
  }
  return { assets, proposals };
}

/**
 * Returns the recommended third-party skills, whether they are installed, and a proposal for each
 * one that is installed and not yet used at its step in the shared workflow.
 */
export function proposeGlobal() {
  const names = userAssets().skills.map((skill) => skill.name);
  const loose = names.includes(RECOMMENDED.marker);
  const find = (skill) => names.find((name) => name.endsWith(`:${skill}`) && name.toLowerCase().includes('mattpocock')) || (loose && names.includes(skill) ? skill : null);
  const workflow = resolveWorkflow(null);
  const dismissed = new Set(readConfig().dismissedProposals || []);
  const items = RECOMMENDED.items.map((item) => ({ ...item, ref: find(item.skill) }));
  const proposals = [];
  for (const item of items) {
    if (!item.ref || workflow[item.pipeline][item.stage].use.some((entry) => entry.ref === item.ref)) continue;
    const types = (item.types || []).filter((type) => workflow.types.includes(type));
    const id = `use:${item.pipeline}:${item.stage}:${item.ref}`;
    if (dismissed.has(id)) continue;
    const step = item.pipeline === 'review' ? item.stage : stageTitle(workflow, item.stage);
    proposals.push({
      id,
      action: 'use',
      pipeline: item.pipeline,
      stage: item.stage,
      use: { ref: item.ref, kind: 'skill', ...(types.length ? { types } : {}) },
      title: `Use skill "${item.skill}" at ${item.pipeline === 'review' ? 'review ' : ''}${step}${types.length ? ` for ${types.join(', ')}` : ''}`,
      reason: item.why,
      effect: `When ${item.pipeline === 'review' ? 'a pull request review' : types.length ? `a ${types.join(' or ')} task` : 'a task'} of any project reaches the "${step}" step, the agent is told to invoke the skill "${item.ref}", in addition to the step's instructions.${types.length ? ' Other task types are not affected.' : ''} A project with its own skills for that step keeps them instead.`,
      undo: `Open the ${item.pipeline === 'review' ? 'review ' : ''}"${step}" step for all projects and remove it under "Skills and agents".`,
      note: item.note || '',
    });
  }
  return { assets: null, proposals, recommended: { name: RECOMMENDED.name, author: RECOMMENDED.author, license: RECOMMENDED.license, url: RECOMMENDED.url, install: RECOMMENDED.install, installed: items.some((item) => item.ref), items: items.map(({ skill, pipeline, stage, why, ref }) => ({ skill, pipeline, stage, why, installed: Boolean(ref) })) } };
}

/** Applies the proposals with the given ids to a project, or to "global", and returns the ids applied. */
export const acceptProposals = (key, ids) => withSettings(() => acceptProposalsNow(key, ids));

function acceptProposalsNow(key, ids) {
  const wanted = new Set(ids);
  const shared = key === 'global';
  const picked = (shared ? proposeGlobal() : proposeForProject(key)).proposals.filter((proposal) => wanted.has(proposal.id));
  const unknown = ids.filter((id) => !picked.some((proposal) => proposal.id === id));
  if (unknown.length) throw new Error(`No open proposal "${unknown[0]}" for ${key}. Reload the page; it may already be applied.`);

  const override = structuredClone(workflowOverride(key));
  const resolved = resolveWorkflow(shared ? null : key);
  for (const proposal of picked) {
    if (proposal.action === 'use') {
      override[proposal.pipeline] ??= {};
      override[proposal.pipeline][proposal.stage] ??= {};
      const stage = override[proposal.pipeline][proposal.stage];
      stage.use = [...(stage.use || resolved[proposal.pipeline][proposal.stage].use), proposal.use];
    }
    if (proposal.action === 'readFirst') override.readFirst = [...new Set([...(override.readFirst || resolved.readFirst), ...proposal.files])];
  }
  if (picked.some((proposal) => ['use', 'readFirst'].includes(proposal.action))) saveWorkflow(key, override);

  const gates = picked.filter((proposal) => proposal.action === 'gate').map((proposal) => proposal.gate);
  if (gates.length) updateProject(key, { gates: [...getRepo(key).gates, ...gates] });

  const sections = picked.find((proposal) => proposal.action === 'prBody');
  const evidence = picked.some((proposal) => proposal.action === 'prEvidence');
  if (sections || evidence) {
    const registry = loadRegistry();
    const before = registry.repos[key].prBody?.requiredSections || [];
    const next = sections ? sections.sections : before.filter((name) => name !== EVIDENCE);
    registry.repos[key].prBody = { ...registry.repos[key].prBody, requiredSections: evidence || before.includes(EVIDENCE) ? [...next, EVIDENCE] : next };
    saveRegistry(registry);
  }
  return picked.map((proposal) => proposal.id);
}

/** Hides proposals for a project, so they are not offered again. */
export const dismissProposals = (key, ids) => withSettings(() => dismissProposalsNow(key, ids));

function dismissProposalsNow(key, ids) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length > 300)) throw new Error('ids must be a list of proposal ids.');
  if (key === 'global') {
    writeConfig({ dismissedProposals: [...new Set([...(readConfig().dismissedProposals || []), ...ids])].slice(-200) });
    return;
  }
  const registry = loadRegistry();
  if (!Object.hasOwn(registry.repos, key)) throw new Error(`Unknown project "${key}". Registered: ${Object.keys(registry.repos).join(', ') || 'none'}.`);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length > 300)) throw new Error('ids must be a list of proposal ids.');
  registry.repos[key].dismissedProposals = [...new Set([...(registry.repos[key].dismissedProposals || []), ...ids])].slice(-200);
  saveRegistry(registry);
}
