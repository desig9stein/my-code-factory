// Lists GitHub issues of the registered projects through the GitHub CLI.
import fs from 'node:fs';
import { configPath } from './paths.mjs';
import { loadRegistry } from './registry.mjs';
import { run } from './sh.mjs';
import { listStates } from './state.mjs';

// Mirrored by the "who" options of the GitHub issues view in web/app.js.
const WHO = {
  assigned: () => ['--assignee', '@me'],
  created: () => ['--author', '@me'],
  mentioned: () => ['--mentions', '@me'],
  involved: () => ['--involves', '@me'],
  user: (filter) => ['--assignee', filter.login],
  anyone: () => [],
};
const STATES = ['open', 'closed'];
const LOGIN = /^[a-zA-Z\d](?:[a-zA-Z\d-]{0,38})$/;
const DEFAULT_FILTER = { who: 'assigned', login: '', state: 'open', label: '' };
const LIMIT = 200;

/** Returns a checked filter; throws with the valid values when a field is wrong. */
export function checkIssueFilter(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The issue filter must be an object.');
  const unknown = Object.keys(input).find((field) => !Object.hasOwn(DEFAULT_FILTER, field));
  if (unknown) throw new Error(`"${unknown}" is not an issue filter field. Valid fields: ${Object.keys(DEFAULT_FILTER).join(', ')}.`);
  const filter = { ...DEFAULT_FILTER, ...input };
  if (!Object.hasOwn(WHO, filter.who)) throw new Error(`"${filter.who}" is not a valid "who". Valid values: ${Object.keys(WHO).join(', ')}.`);
  if (!STATES.includes(filter.state)) throw new Error(`"${filter.state}" is not a valid state. Valid values: ${STATES.join(', ')}.`);
  filter.login = String(filter.login ?? '').trim().replace(/^@/, '');
  if (filter.who === 'user' && !LOGIN.test(filter.login)) throw new Error(`"${filter.login}" is not a GitHub login. Use letters, digits and hyphens, for example "octocat".`);
  if (filter.who !== 'user') filter.login = '';
  filter.label = String(filter.label ?? '').trim();
  if (/[\r\n]/.test(filter.label) || filter.label.length > 100) throw new Error('The label must be one line of at most 100 characters.');
  return filter;
}

function readConfig() {
  return fs.existsSync(configPath()) ? JSON.parse(fs.readFileSync(configPath(), 'utf8')) : {};
}

/** Returns the saved issue filter, or the default when none is saved or it no longer validates. */
export function issueFilter() {
  try {
    return checkIssueFilter(readConfig().issues);
  } catch {
    return { ...DEFAULT_FILTER };
  }
}

/** Validates and saves the issue filter in config.json. */
export function saveIssueFilter(input) {
  const filter = checkIssueFilter(input);
  const tmp = `${configPath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...readConfig(), issues: filter }, null, 2)}\n`);
  fs.renameSync(tmp, configPath());
  return filter;
}

/** Builds the "gh" arguments for a filter over the given owner/repo names. */
export function issueArgs(filter, remotes) {
  const args = ['search', 'issues', ...WHO[filter.who](filter), '--state', filter.state];
  if (filter.label) args.push('--label', filter.label);
  for (const remote of remotes) args.push('--repo', remote);
  return [...args, '--sort', 'updated', '--limit', String(LIMIT), '--json', 'number,title,repository,url,labels,assignees,updatedAt'];
}

/** Returns the issues matching the saved filter in every registered project. */
export function searchIssues(filter = issueFilter()) {
  const registry = loadRegistry();
  const projects = new Map();
  // The first project registered for a remote owns its issues.
  for (const [key, repo] of Object.entries(registry.repos)) if (!projects.has(repo.remote.toLowerCase())) projects.set(repo.remote.toLowerCase(), { key, remote: repo.remote });
  // Without a --repo argument the search would cover all of GitHub.
  if (!projects.size) return { filter, limit: LIMIT, issues: [] };
  const result = run('gh', issueArgs(filter, [...projects.values()].map((p) => p.remote)));
  if (result.status !== 0) {
    if (/ENOENT/.test(result.stderr)) throw new Error('The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run "gh auth login".');
    throw new Error(`GitHub search failed: ${result.stderr.trim().split('\n')[0] || 'no error text'}. Check "gh auth status"; run "gh auth login" when you are logged out.`);
  }
  const issues = JSON.parse(result.stdout || '[]').map((issue) => {
    const project = projects.get(String(issue.repository?.nameWithOwner || '').toLowerCase());
    return {
      project: project?.key || null,
      remote: issue.repository?.nameWithOwner || '',
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels: (issue.labels || []).map((label) => label.name),
      assignees: (issue.assignees || []).map((user) => user.login),
      updatedAt: issue.updatedAt,
    };
  }).filter((issue) => issue.project);
  return { filter, limit: LIMIT, issues };
}

/** Posts a file as a comment on an issue or pull request, as the logged-in GitHub user. */
export function commentFromFile(remote, number, file) {
  const result = run('gh', ['issue', 'comment', String(number), '-R', remote, '--body-file', file]);
  if (result.status !== 0) throw new Error(`The comment was not posted: ${result.stderr.trim().split('\n')[0] || 'gh failed'}. Check "gh auth status".`);
  return result.stdout.trim().split('\n').at(-1);
}

/** Adds the task id and stage to every issue the factory already works on. */
export function withTasks(issues) {
  const tasks = listStates().filter((state) => state.kind !== 'review');
  return issues.map((issue) => {
    const task = tasks.find((state) => state.repo === issue.project && state.issue === issue.number);
    return { ...issue, task: task ? { id: task.id, stage: task.stage } : null };
  });
}
