// Builds the report of one day: what Codeignite, git and GitHub recorded, and a short summary of it.
import { agentSettings } from './agents.mjs';
import { harness } from './harnesses.mjs';
import { execFile } from 'node:child_process';
import { listEvidence } from './evidence.mjs';
import { getRepo, loadRegistry } from './registry.mjs';
import { run, tryGit } from './sh.mjs';
import { listStates } from './state.mjs';
import { builtInTitle } from './workflow.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PRS = 50;
const MAX_COMMITS = 40;
const WRITER_MODEL = 'sonnet';
const WRITER_TIMEOUT_MS = 120_000;

const pad = (n) => String(n).padStart(2, '0');
const localDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Returns the day to report as YYYY-MM-DD; accepts "today", "yesterday" or a date. */
export function reportDay(input = 'today') {
  const now = new Date();
  if (!input || input === 'today') return localDay(now);
  if (input === 'yesterday') return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  // A day that is not on the calendar, such as February 31, would be read as a day in March.
  if (!DAY.test(input) || Number.isNaN(Date.parse(`${input}T00:00:00`)) || localDay(new Date(`${input}T00:00:00`)) !== input) throw new Error(`"${input}" is not a day. Use today, yesterday, or a date such as 2026-11-20.`);
  return input;
}

// What a stage reached on the day means in plain words; stages not listed are progress only.
const MILESTONES = {
  intake: 'started',
  ready: 'made ready for your review',
  approved: 'approved by you',
  'pr-opened': 'pull request opened',
  posted: 'review posted',
  blocked: 'blocked',
  archived: 'archived',
};

function taskFacts(day, registry) {
  const inDay = (iso) => iso && localDay(new Date(iso)) === day;
  const tasks = [];
  for (const state of listStates({ archived: true })) {
    const history = (state.history || []).filter((h) => inDay(h.at));
    const runs = listEvidence(state.id).filter((r) => inDay(r.startedAt) && ['gate', 'step', 'run'].includes(r.kind));
    if (!history.length && !runs.length) continue;
    const before = history.length ? (state.history || []).filter((h) => h.at < history[0].at && !['blocked', 'archived'].includes(h.stage)).at(-1)?.stage || null : null;
    const moves = history.filter((h) => !['blocked', 'archived'].includes(h.stage)).map((h) => h.stage);
    tasks.push({
      id: state.id,
      kind: state.kind === 'review' ? 'review' : 'issue',
      project: state.repo,
      remote: registry.repos[state.repo]?.remote || null,
      number: state.issue,
      title: state.title,
      url: state.url || null,
      prUrl: history.some((h) => h.stage === 'pr-opened') ? state.prUrl || null : null,
      from: before,
      to: moves.at(-1) || state.stage,
      milestones: [...new Set(history.map((h) => MILESTONES[h.stage]).filter(Boolean))],
      checks: { passed: runs.filter((r) => r.ok).length, failed: runs.filter((r) => !r.ok).length },
    });
  }
  return tasks;
}

function commitFacts(day, registry) {
  const seen = new Set();
  const out = [];
  for (const key of Object.keys(registry.repos)) {
    const { dir } = getRepo(key, registry);
    const email = tryGit(dir, 'config', 'user.email');
    if (!email || seen.has(`${dir}`)) continue;
    seen.add(dir);
    // Git picks the commits of the day by when they were committed, so the day of each one is read from that same time.
    const log = tryGit(dir, 'log', '--all', '--no-merges', `--author=${email}`, `--since=${day}T00:00:00`, `--until=${day}T23:59:59`, '--date=iso-strict', '--format=%H%x1f%cd%x1f%s');
    if (!log) continue;
    const commits = [...new Map(log.split('\n').map((line) => line.split('\x1f')).filter(([, at]) => at && localDay(new Date(at)) === day).map(([sha, , subject]) => [sha, { sha: sha.slice(0, 8), subject }])).values()];
    if (commits.length) out.push({ project: key, count: commits.length, commits: commits.slice(0, MAX_COMMITS) });
  }
  return out;
}

function pullRequestFacts(day, registry) {
  const remotes = [...new Set(Object.values(registry.repos).map((repo) => repo.remote))];
  if (!remotes.length) return { opened: [], merged: [], error: null };
  // The day as this machine counts it. A bare date would be read by GitHub as a day in UTC, and a pull request
  // opened near midnight would land on the day before or after.
  const offset = (at) => {
    const minutes = -new Date(at).getTimezoneOffset();
    return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
  };
  const range = `${day}T00:00:00${offset(`${day}T00:00:00`)}..${day}T23:59:59${offset(`${day}T23:59:59`)}`;
  let limited = false;
  const search = (qualifier) => {
    const args = ['search', 'prs', '--author', '@me', qualifier, range, ...remotes.flatMap((remote) => ['--repo', remote]), '--limit', String(MAX_PRS), '--json', 'number,title,url,repository,state'];
    const result = run('gh', args);
    if (result.status !== 0) throw new Error(result.stderr.trim().split('\n')[0] || 'gh failed');
    let found = null;
    try {
      found = JSON.parse(result.stdout || '[]');
    } catch {
      // Said below.
    }
    if (!Array.isArray(found)) throw new Error('the answer was not what GitHub sends');
    if (found.length >= MAX_PRS) limited = true;
    return found.filter((pr) => pr && typeof pr === 'object').map((pr) => ({ repo: pr.repository?.nameWithOwner || '', number: pr.number, title: pr.title, url: pr.url }));
  };
  try {
    const opened = search('--created');
    const merged = search('--merged-at');
    return { opened, merged, error: limited ? `Only the first ${MAX_PRS} pull requests of a kind are listed; there may be more.` : null };
  } catch (err) {
    return { opened: [], merged: [], error: `GitHub pull requests are not included: ${err.message}. Check "gh auth status".` };
  }
}

/** Collects what was recorded for a day: Codeignite tasks, your commits and your pull requests. */
export function dayFacts(input) {
  const day = reportDay(input);
  const registry = loadRegistry();
  const facts = { day, tasks: taskFacts(day, registry), commits: commitFacts(day, registry), pullRequests: pullRequestFacts(day, registry) };
  return { ...facts, summary: summarize(facts) };
}

const longDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** Writes the facts as short sentences. Every line states something that was recorded. */
export function summarize({ day, tasks, commits, pullRequests }) {
  const total = commits.reduce((n, c) => n + c.count, 0);
  const lines = [longDay(day), ''];
  if (!tasks.length && !total && !pullRequests.opened.length && !pullRequests.merged.length) {
    lines.push('Nothing was recorded for this day: no Codeignite task moved, and no commit or pull request of yours was found in the registered projects.');
    if (pullRequests.error) lines.push('', pullRequests.error);
    return lines.join('\n');
  }
  const projects = new Set([...tasks.map((t) => t.project), ...commits.map((c) => c.project)]);
  lines.push(`You worked in ${plural(projects.size, 'project')}: ${plural(tasks.length, 'Codeignite task')}, ${plural(total, 'commit')}, ${plural(pullRequests.opened.length, 'pull request')} opened, ${pullRequests.merged.length} merged.`, '');
  if (tasks.length) {
    lines.push('Tasks');
    for (const t of tasks) {
      const name = (stage) => builtInTitle(stage, t.kind === 'review');
      const moved = t.from && t.from !== t.to ? `moved from ${name(t.from)} to ${name(t.to)}` : `now at ${name(t.to)}`;
      const checks = t.checks.passed + t.checks.failed ? ` Checks run: ${t.checks.passed} passed, ${t.checks.failed} failed.` : '';
      lines.push(`- ${t.project} ${t.kind === 'review' ? 'review of PR ' : ''}#${t.number}, "${t.title}": ${[...t.milestones, moved].join(', ')}.${checks}${t.prUrl ? ` ${t.prUrl}` : ''}`);
    }
    lines.push('');
  }
  if (pullRequests.opened.length || pullRequests.merged.length) {
    lines.push('Pull requests');
    for (const pr of pullRequests.opened) lines.push(`- Opened ${pr.repo}#${pr.number}, "${pr.title}". ${pr.url}`);
    for (const pr of pullRequests.merged) lines.push(`- Merged ${pr.repo}#${pr.number}, "${pr.title}". ${pr.url}`);
    lines.push('');
  }
  if (total) {
    lines.push('Commits');
    for (const c of commits) lines.push(`- ${c.project}: ${plural(c.count, 'commit')}. ${c.commits.slice(0, 4).map((x) => x.subject).join('; ')}${c.count > 4 ? '; and more' : ''}.`);
    lines.push('');
  }
  if (pullRequests.error) lines.push(pullRequests.error);
  return lines.join('\n').trimEnd();
}

const WRITER_RULES = `You write a short end-of-day work report for a software developer, from a list of recorded facts.
Rules:
- Plain English a non-developer manager can follow. Short sentences. First person ("I"). Past tense.
- At most 120 words, as 3 to 6 bullet points, each starting with "- ". No heading, no greeting, no sign-off.
- Group by outcome: what was finished, what moved forward, what is waiting on someone.
- Use only the facts given. Never add work, numbers, reasons or results that are not in them.
- Name projects and issue numbers. Translate commit and task titles into what was done; do not paste them.
- If the facts say nothing was recorded, say that in one sentence.`;

/**
 * Asks the Claude CLI to rewrite the facts of a day in plain English. The model gets no tools,
 * only the summary text, and resolves with what it wrote.
 */
export function writePlainReport(facts) {
  return new Promise((resolve, reject) => {
    // The same program and account as the sessions the board starts, so a key in the shell is not billed by accident.
    const { cmd, env } = harness('claude').command({ prompt: '', permission: 'own', account: agentSettings().account });
    const child = execFile(cmd, ['-p', '--model', WRITER_MODEL, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', WRITER_RULES], { env, timeout: WRITER_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT') return reject(new Error('The Claude CLI (claude) is not installed, so the report cannot be rewritten. The summary above still holds.'));
      if (err) return reject(new Error(`Claude could not write the report: ${(stderr || err.message).trim().split('\n')[0]}`));
      const text = stdout.trim();
      return text ? resolve(text) : reject(new Error('Claude returned an empty report.'));
    });
    child.stdin.end(`Facts recorded for ${longDay(facts.day)}:\n\n${facts.summary}\n`);
  });
}
