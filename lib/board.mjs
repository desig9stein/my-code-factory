// Writes the kanban board page and its data file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { activitySummary } from './activity.mjs';
import { latest, listEvidence, verifyChain } from './evidence.mjs';
import os from 'node:os';
import { codeRoot, factoryRoot, issueDir, workspace } from './paths.mjs';
import { coverage, workspaceGraph } from './graph.mjs';
import { factoryMetrics } from './metrics.mjs';
import { getRepo, loadRegistry } from './registry.mjs';
import { acceptanceCriteria, approvalKey, blockKind, changeStats, consumerImpact, gateStatus, inspect, stageNeeds, regressStatus, reviewVerdict } from './stages.mjs';
import { REVIEW_STAGES, STAGES, head, listStates } from './state.mjs';
import { issueTokens, lastActivity } from './tokens.mjs';
import { formatBrief, resolveWorkflow, stageBrief, stageTitle, workflowShape } from './workflow.mjs';

// Record kinds whose proof holds only for the commit they ran on.
const SHA_BOUND_KINDS = ['gate', 'step', 'regress', 'verdict', 'manual'];
const DOCS = { answers: 'answers.md', issue: 'issue.md', review: 'review.md', pr: 'pr.md', triage: 'triage.md', questions: 'questions.md', plan: 'plan.md', verify: 'verify.md', prBody: 'pr-body.md' };

// Returns the text "factory next" prints, or the reason it cannot be built.
function brief(state, repo) {
  try {
    return formatBrief(stageBrief(state, repo), inspect(state, repo));
  } catch (err) {
    return `The brief could not be built: ${err.message}`;
  }
}

// The first message for an agent session on a task. It names the CLI, so it works before the skill is installed.
const agentPrompt = (state) => `Work on the Codeignite task ${state.id} with the factory skill. Start by running: node '${path.join(codeRoot(), 'bin', 'factory.mjs')}' next ${state.id}`;

// Places a stage in one of the board's columns: start, build, check, review or ship.
function phaseOf(state, shape) {
  if (state.stage === 'ready') return 'review';
  if (['approved', 'pr-opened', 'posted'].includes(state.stage)) return 'ship';
  if (state.kind === 'review') return state.stage === 'draft' ? 'build' : state.stage === 'checks' ? 'check' : 'start';
  const order = shape.stages.map((item) => item.stage);
  const at = order.indexOf(state.stage);
  return at < order.indexOf('implement') ? 'start' : at === order.indexOf('implement') ? 'build' : 'check';
}

// Returns who acts at the task's stage, what happens there and what its exit rule still misses.
function progress(state, repo) {
  try {
    const shape = workflowShape(resolveWorkflow(state.repo));
    const step = (state.kind === 'review' ? shape.review : shape.stages).find((item) => item.stage === state.stage);
    const check = inspect(state, repo);
    return { actor: step?.actor || 'Agent', about: step?.about || '', phase: phaseOf(state, shape), missing: check.problems, attempts: check.attempts ? { failed: check.attempts.failed, max: check.attempts.max } : null };
  } catch {
    return { actor: 'Agent', about: '', phase: 'start', missing: [], attempts: null };
  }
}

// The hash of the drafted questions, so the board posts only the text it showed.
function questionsSha(id) {
  const file = path.join(issueDir(id), 'questions.md');
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

// Returns the display name of the task's stage.
function stageName(state) {
  try {
    return state.kind === 'review' ? (state.stage === 'ready' ? 'human review' : state.stage) : stageTitle(resolveWorkflow(state.repo), state.stage);
  } catch {
    return state.stage;
  }
}

function readDoc(id, name) {
  const file = path.join(issueDir(id), name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Collects everything the board shows for every issue in flight. */
export function boardData() {
  const registry = loadRegistry();
  const graph = workspaceGraph(registry);
  const issues = listStates().map((s) => {
    const repo = getRepo(s.repo, registry);
    const records = listEvidence(s.id);
    const verifier = gateStatus(s, repo, { actor: 'verifier' });
    const now = head(s);
    return {
      id: s.id,
      kind: s.kind === 'review' ? 'review' : 'issue',
      approvalKey: s.stage === 'ready' && !s.blocked ? approvalKey(s) : null,
      author: s.author || null,
      reviewVerdict: s.kind === 'review' ? reviewVerdict(s.id) : null,
      repo: s.repo,
      issue: s.issue,
      title: s.title,
      url: s.url,
      type: s.type,
      tier: s.tier || null,
      criteria: s.kind === 'review' ? [] : acceptanceCriteria(s.id),
      needs: stageNeeds(s, repo),
      // Who a change in this project reaches, and whether the plan's Consumer impact names each one.
      reach: s.kind === 'review' ? [] : coverage(graph, s.repo, consumerImpact(s.id)),
      hasPlan: Boolean(readDoc(s.id, 'plan.md')),
      changes: now ? changeStats(s) : null,
      stage: s.stage,
      stageTitle: stageName(s),
      worktree: s.worktree,
      prompt: agentPrompt(s),
      blocked: s.blocked?.reason || null,
      blockedKind: blockKind(s),
      ...progress(s, repo),
      questionsSha: questionsSha(s.id),
      lastActivity: lastActivity(s.id),
      questionsPosted: s.questionsPosted || null,
      sentBack: s.sentBack?.reason || null,
      branch: s.branch,
      base: s.base,
      head: now,
      stageSince: s.stageSince,
      prUrl: s.prUrl,
      gates: gateStatus(s, repo).map((g, i) => ({ name: g.name, status: g.status, verifier: s.kind === 'review' ? null : verifier[i].status })),
      regress: s.type === 'bug' || regressStatus(s) !== 'missing' ? regressStatus(s) : null,
      verdict: latest(records, 'verdict', (r) => r.sha === now)?.verdict || null,
      tampered: verifyChain(s.id),
      tokens: issueTokens(s),
      brief: brief(s, repo),
      activity: activitySummary(s),
      history: s.history,
      evidence: records.map((r) => ({
        seq: r.seq,
        name: r.name,
        kind: r.kind,
        actor: r.actor,
        cmd: r.cmd || null,
        text: r.text || null,
        verdict: r.verdict || null,
        expect: r.expect || null,
        baseSha: r.baseSha || null,
        exitCode: r.exitCode ?? null,
        ok: r.ok,
        sha: r.sha,
        stale: SHA_BOUND_KINDS.includes(r.kind) && r.sha !== now,
        dirty: r.dirty,
        startedAt: r.startedAt,
        durationMs: r.durationMs ?? null,
        log: r.log ? `issues/${s.id}/evidence/${r.log}` : null,
      })),
      docs: Object.fromEntries(Object.entries(DOCS).map(([k, f]) => [k, readDoc(s.id, f)])),
    };
  });
  const projects = Object.keys(registry.repos).map((key) => {
    const repo = getRepo(key, registry);
    return { key, remote: repo.remote, dir: repo.dir, baseBranch: repo.baseBranch, install: repo.install || '', gates: repo.gates, description: String(repo.description || ''), owns: String(repo.owns || '') };
  });
  // The header shows the workspace with the home folder shortened to "~".
  const home = os.homedir();
  return { stages: STAGES, reviewStages: REVIEW_STAGES, issues, projects, graph, metrics: factoryMetrics(), workspace: workspace().startsWith(home) ? `~${workspace().slice(home.length)}` : workspace() };
}

/** Returns the board data as a script that hands it to the page. */
export function boardScript() {
  const data = boardData();
  data.stamp = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  // Escapes "<" so issue text cannot close the script element.
  return `window.__factoryData(${JSON.stringify(data).replace(/</g, '\\u003c')});\n`;
}

export const boardTemplate = () => {
  const read = (file) => fs.readFileSync(path.join(codeRoot(), 'web', file), 'utf8');
  const footprint = `${read('footprint.mjs').replaceAll('export ', '')}\n${read('workflow.js')}`;
  const logo = read('logo.svg').trim();
  return read('index.html').replace('/*factory-style*/', read('style.css'))
    // The header draws the logo inline; the tab icon carries the same file as a data URI.
    .replace('<!--factory-logo-->', () => logo.replace('role="img" aria-label="Codeignite"', 'aria-hidden="true" class="fd-logo"'))
    .replace('/*factory-icon*/', () => encodeURIComponent(logo))
    .replace('/*factory-client*/', () => footprint + '\n' + read('app.js'));
};

/** Writes board.html and board-data.js; returns the page path. */
export function writeBoard() {
  const root = factoryRoot();
  fs.mkdirSync(root, { recursive: true });
  const page = path.join(root, 'board.html');
  const template = boardTemplate();
  if (!fs.existsSync(page) || fs.readFileSync(page, 'utf8') !== template) fs.writeFileSync(page, template);

  const body = boardScript();
  const file = path.join(root, 'board-data.js');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return page;
}
