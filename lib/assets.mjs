// Finds the skills, agents, instruction files and PR template a project already has, and proposes how to use them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRepo, loadRegistry } from './registry.mjs';
import { saveRegistry, updateProject } from './setup.mjs';
import { resolveWorkflow, saveWorkflow, workflowOverride } from './workflow.mjs';

// Ordered by preference: Claude Code invokes only what lives under .claude.
const SKILL_DIRS = ['.claude/skills', '.agents/skills', '.github/skills'];
const AGENT_DIRS = ['.claude/agents', '.agents/agents', '.github/agents'];
const PRODUCT_DIR = 'skills';
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.github/copilot-instructions.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md'];
const READ_FIRST = ['AGENTS.md', 'CLAUDE.md'];
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

// Finds the "skills" folders of installed plugins; the folder above each one names the plugin.
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

/** Returns the user's own skills and agents, including plugin skills, with their descriptions. */
export function userAssets() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const describe = (file, name) => ({ name, description: (frontMatter(fs.readFileSync(file, 'utf8')).description || '').slice(0, 400) });
  const skills = new Map();
  for (const file of skillFiles(path.join(dir, 'skills'))) skills.set(path.dirname(file), describe(path.join(dir, 'skills', file), path.dirname(file)));
  for (const folder of pluginSkillDirs(path.join(dir, 'plugins'))) {
    const plugin = path.basename(path.dirname(folder));
    for (const file of skillFiles(folder)) {
      const name = `${plugin}:${path.dirname(file)}`;
      if (!skills.has(name)) skills.set(name, describe(path.join(folder, file), name));
    }
  }
  const agents = agentFiles(path.join(dir, 'agents')).map((file) => describe(path.join(dir, 'agents', file), path.basename(file, '.md')));
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { skills: [...skills.values()].sort(byName).slice(0, 300), agents: agents.sort(byName) };
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
        note: asset.differs ? `Copies differ: ${asset.copies.join(', ')}. This uses ${asset.path}.` : '',
      });
    }
  }

  const readFirst = READ_FIRST.filter((file) => assets.instructions.includes(file) && !workflow.readFirst.includes(file));
  if (readFirst.length) add({ id: `readFirst:${readFirst.join(',')}`, action: 'readFirst', files: readFirst, title: `Tell the agent to read ${readFirst.join(' and ')} first`, reason: 'Listed at the top of every stage brief for this project.', note: '' });

  if (assets.prTemplate) {
    const sections = templateSections(repo.dir, assets.prTemplate);
    const current = registry.repos[key].prBody?.requiredSections || [];
    if (sections.length && JSON.stringify(sections) !== JSON.stringify(current)) add({ id: `prBody:${digest(sections.join('|')).slice(0, 8)}`, action: 'prBody', sections, title: `Require the PR template sections: ${sections.join(', ')}`, reason: `From ${assets.prTemplate}. The verify stage rejects a PR description that leaves one empty.`, note: '' });
  }

  const gated = repo.gates.map((gate) => gate.cmd).join(' ; ');
  for (const script of namedScripts(repo.dir, assets.instructions)) {
    const cmd = script === 'test' ? 'npm test' : `npm run ${script}`;
    const name = script.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (new RegExp(`(^|[\\s;&])${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s;&])`).test(gated) || repo.gates.some((gate) => gate.name === name)) continue;
    add({ id: `gate:${name}`, action: 'gate', gate: { name, cmd }, title: `Add gate "${name}": ${cmd}`, reason: 'The project instructions name this script and no gate runs it yet.', note: '' });
  }
  return { assets, proposals };
}

/** Applies the proposals with the given ids to a project and returns the ids applied. */
export function acceptProposals(key, ids) {
  const wanted = new Set(ids);
  const picked = proposeForProject(key).proposals.filter((proposal) => wanted.has(proposal.id));
  const unknown = ids.filter((id) => !picked.some((proposal) => proposal.id === id));
  if (unknown.length) throw new Error(`No open proposal "${unknown[0]}" for ${key}. Reload the page; it may already be applied.`);

  const override = structuredClone(workflowOverride(key));
  const resolved = resolveWorkflow(key);
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
  if (sections) {
    const registry = loadRegistry();
    registry.repos[key].prBody = { ...registry.repos[key].prBody, requiredSections: sections.sections };
    saveRegistry(registry);
  }
  return picked.map((proposal) => proposal.id);
}

/** Hides proposals for a project, so they are not offered again. */
export function dismissProposals(key, ids) {
  const registry = loadRegistry();
  if (!Object.hasOwn(registry.repos, key)) throw new Error(`Unknown project "${key}". Registered: ${Object.keys(registry.repos).join(', ') || 'none'}.`);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length > 300)) throw new Error('ids must be a list of proposal ids.');
  registry.repos[key].dismissedProposals = [...new Set([...(registry.repos[key].dismissedProposals || []), ...ids])].slice(-200);
  saveRegistry(registry);
}
