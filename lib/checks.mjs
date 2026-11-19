// Checks the commits on the branch and the PR body draft.
import fs from 'node:fs';
import path from 'node:path';
import { issueDir } from './paths.mjs';
import { tryGit } from './sh.mjs';

const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert|content|seo|hotfix|changelog';
const SUBJECT = new RegExp(`^(${TYPES})\\([^)\\s][^)]*\\)!?: \\S.*$`);
const ATTRIBUTION = /co-authored-by:.*(claude|anthropic|copilot|openai|cursor|gemini)|generated with|claude code|🤖/i;
const NOISE = /^(fixup!|squash!|wip\b)|address (review )?comments/i;

/** Returns the merge base of HEAD and the remote base branch. */
export function mergeBase(state) {
  return tryGit(state.worktree, 'merge-base', 'HEAD', `origin/${state.base}`) || state.baseSha;
}

export function commitsOnBranch(state) {
  const out = tryGit(state.worktree, 'log', '--format=%H%x1f%s%x1f%b%x1e', `${mergeBase(state)}..HEAD`);
  if (!out) return [];
  return out
    .split('\x1e')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, subject, body = ''] = c.split('\x1f');
      return { sha, subject, body };
    });
}

/** Returns the commit rule violations; an empty list means the check passes. */
export function checkCommits(state, repo) {
  const commits = commitsOnBranch(state);
  const problems = [];
  const max = repo.maxCommits ?? 3;
  if (commits.length === 0) problems.push(`No commits on ${state.branch} since origin/${state.base}.`);
  if (commits.length > max) {
    problems.push(`${commits.length} commits on the branch; squash to ${max} or fewer substantive commits.`);
  }
  for (const c of commits) {
    const at = `${c.sha.slice(0, 8)} "${c.subject}"`;
    if (repo.conventionalCommits !== false && !SUBJECT.test(c.subject)) {
      problems.push(`${at} is not Conventional Commits with a scope. Use "<type>(<scope>): <behavior>"; types: ${TYPES.replaceAll('|', ', ')}.`);
    }
    if (NOISE.test(c.subject)) problems.push(`${at} is a fix-up or WIP commit. Squash it into the commit it belongs to.`);
    if (repo.forbidAiAttribution === true && ATTRIBUTION.test(`${c.subject}\n${c.body}`)) problems.push(`${at} carries AI attribution. Remove the line.`);
  }
  return problems;
}

// Splits a PR body into its opening text and "## Heading" sections.
function sections(body) {
  const out = { opening: '', byName: {} };
  let current = null;
  for (const line of body.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = m[1].trim().toLowerCase();
      out.byName[current] = '';
    } else if (current) out.byName[current] += `${line}\n`;
    else out.opening += `${line}\n`;
  }
  return out;
}

export const prBodyPath = (id) => path.join(issueDir(id), 'pr-body.md');

/** Returns the PR body violations for the repo's rules; empty means it passes. */
export function checkPrBody(state, repo) {
  const file = prBodyPath(state.id);
  if (!fs.existsSync(file)) return [`pr-body.md is missing. Write the PR description to ${file}.`];
  const body = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const problems = [];
  const rules = repo.prBody || {};
  const { opening, byName } = sections(body);
  const text = (name) => (byName[name.toLowerCase()] || '').trim();
  const filled = (name) => text(name).length > 0 && !/^(n\/?a|none|-|tbd)\.?$/i.test(text(name));

  if (!body.trim()) problems.push('pr-body.md is empty.');
  if (repo.forbidAiAttribution === true && ATTRIBUTION.test(body)) problems.push('The PR body carries AI attribution. Remove the line.');
  if (state.kind !== 'review' && !new RegExp(`#${state.issue}\\b`).test(body)) {
    problems.push(`The PR body never references #${state.issue}. Add "Closes #${state.issue}." or "Part of #${state.issue}.".`);
  }
  if (rules.opening && !opening.trim()) {
    problems.push('The PR body starts with a heading. Open with "Closes #N." or one sentence of what and why.');
  }
  for (const name of rules.requiredSections || []) {
    if (!filled(name)) problems.push(`"## ${name}" is missing or empty; ${repo.key} CI rejects the PR without it.`);
  }
  if (rules.tickedSection && !/^\s*-\s*\[[xX]\]/m.test(text(rules.tickedSection))) {
    problems.push(`Tick at least one box under "## ${rules.tickedSection}".`);
  }
  return problems;
}
