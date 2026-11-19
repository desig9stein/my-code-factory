// Writes the kanban board page and its data file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { activitySummary } from './activity.mjs';
import { latest, listEvidence, verifyChain } from './evidence.mjs';
import { codeRoot, factoryRoot, issueDir } from './paths.mjs';
import { coverage, workspaceGraph } from './graph.mjs';
import { factoryMetrics } from './metrics.mjs';
import { getRepo, loadRegistry } from './registry.mjs';
import { rememberingGit } from './sh.mjs';
import { acceptanceCriteria, approvalKey, changeStats, consumerImpact, gateStatus, stageNeeds, regressStatus, reviewVerdict } from './stages.mjs';
import { REVIEW_STAGES, STAGES, head, listStates, unreadableStates } from './state.mjs';
import { issueTokens } from './tokens.mjs';

// Record kinds whose proof holds only for the commit they ran on.
const SHA_BOUND_KINDS = ['gate', 'regress', 'verdict', 'manual'];
const DOCS = { issue: 'issue.md', review: 'review.md', pr: 'pr.md', triage: 'triage.md', questions: 'questions.md', plan: 'plan.md', verify: 'verify.md', prBody: 'pr-body.md' };

function readDoc(id, name) {
  const file = path.join(issueDir(id), name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Collects everything the board shows for every issue in flight. */
export function boardData() {
  return rememberingGit(collect);
}

function collect() {
  const registry = loadRegistry();
  const graph = workspaceGraph(registry);
  const skipped = [];
  const issues = listStates().flatMap((s) => {
    try {
      return [describe(s)];
    } catch (err) {
      // A task that cannot be described is reported, and the rest of the board still loads.
      skipped.push({ id: s.id, reason: err.message });
      return [];
    }
  });
  skipped.push(...unreadableStates());
  function describe(s) {
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
      blocked: s.blocked?.reason || null,
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
  }
  const projects = Object.keys(registry.repos).map((key) => {
    const repo = getRepo(key, registry);
    const words = (value) => (typeof value === 'string' ? value : '');
    return { key, remote: words(repo.remote), dir: repo.dir, baseBranch: words(repo.baseBranch), gates: repo.gates.filter((g) => g && typeof g === 'object').map((g) => ({ name: words(g.name), cmd: words(g.cmd) })), description: words(repo.description), owns: words(repo.owns) };
  });
  return { stages: STAGES, reviewStages: REVIEW_STAGES, issues, projects, graph, skipped, metrics: factoryMetrics() };
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
  const footprint = read('footprint.mjs').replaceAll('export ', '');
  return read('index.html').replace('/*factory-style*/', read('style.css'))
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
