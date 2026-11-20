// Carries out what the user approved: pushes the branch and opens the pull request, or posts the review.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { commitsOnBranch, prBodyPath } from './checks.mjs';
import { issueDir } from './paths.mjs';
import { approvalIntact, recordPosted, recordPr, reviewBody, reviewVerdict } from './stages.mjs';
import { isDirty, loadState, sync } from './state.mjs';

const TIMEOUT_MS = 180_000;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
// A login, "@me", or an organization team as org/team.
const PERSON = /^(@me|[a-zA-Z\d](?:[a-zA-Z\d-]{0,38})(\/[a-zA-Z\d][\w.-]{0,99})?)$/;
const MAX_PEOPLE = 10;
const REVIEW_FLAGS = { approve: '--approve', 'request-changes': '--request-changes', comment: '--comment' };

// Runs a program and resolves with its output; a failure rejects with the last line it printed.
function exec(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const failure = new Error((stderr || err.message).trim().split('\n').filter(Boolean).at(-1) || `${cmd} failed`);
        failure.output = `${stdout}\n${stderr}`;
        return reject(failure);
      }
      return resolve(`${stdout}\n${stderr}`);
    });
  });
}

/** Returns the title a pull request for the task gets when none is given: its first commit's subject. */
export function suggestedPrTitle(state) {
  return commitsOnBranch(state).at(-1)?.subject || state.title;
}

// Refuses anything but the exact commit and text the user approved.
function approvedState(id, kind) {
  const state = sync(loadState(String(id)));
  if ((state.kind === 'review') !== (kind === 'review')) throw new Error(`${state.id} is ${state.kind === 'review' ? 'a review of a pull request' : 'an issue to implement'}; this action does not apply to it.`);
  if (state.stage !== 'approved') throw new Error(`${state.id} is at "${state.stage}". It can go out only right after you approve it.`);
  if (!approvalIntact(state)) throw new Error(`${state.id} changed after you approved it: the commit or the approved text is different. Review and approve it again.`);
  if (isDirty(state)) throw new Error(`The worktree of ${state.id} has uncommitted changes, so what would be pushed is not what was checked. Commit or remove them.`);
  return state;
}

/**
 * Pushes the approved branch and opens its pull request with the approved description, then records it.
 * A pull request that already exists for the branch is recorded instead of opened twice.
 */
// Returns the checked logins of a reviewers or assignees list.
function people(value, what) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PEOPLE) throw new Error(`${what} must be a list of at most ${MAX_PEOPLE} GitHub logins.`);
  const list = [...new Set(value.map((x) => String(x).trim().replace(/^@(?!me$)/, '')).filter(Boolean))];
  const bad = list.find((x) => !PERSON.test(x));
  if (bad) throw new Error(`"${bad}" is not a GitHub login. Use a login such as "octocat", or a team as "org/team".`);
  return list;
}

export async function createPullRequest(id, repo, { title, draft = false, reviewers, assignees } = {}) {
  const state = approvedState(id, 'issue');
  const heading = String(title ?? '').trim() || suggestedPrTitle(state);
  if (/[\r\n]/.test(heading) || heading.length > 200) throw new Error('The pull request title must be one line of at most 200 characters.');
  const asked = people(reviewers, 'Reviewers');
  const owners = people(assignees, 'Assignees');
  try {
    await exec('git', ['push', '--set-upstream', 'origin', `${state.branch}:${state.branch}`], state.worktree);
  } catch (err) {
    throw new Error(`The branch could not be pushed: ${err.message}. Nothing was opened on GitHub.`);
  }
  let out;
  try {
    out = await exec('gh', ['pr', 'create', '--repo', repo.remote, '--base', state.base, '--head', state.branch, '--title', heading, '--body-file', prBodyPath(state.id), ...asked.flatMap((x) => ['--reviewer', x]), ...owners.flatMap((x) => ['--assignee', x]), ...(draft ? ['--draft'] : [])], state.worktree);
  } catch (err) {
    // GitHub names the existing pull request when the branch already has one.
    if (!PR_URL.test(err.output || '')) throw new Error(`The branch is pushed, but the pull request could not be opened: ${err.message}. Open it on GitHub, then record its address.`);
    out = err.output;
  }
  const url = PR_URL.exec(out)?.[0];
  if (!url) throw new Error('GitHub did not return the address of the pull request. Open GitHub to find it, then record its address.');
  recordPr(loadState(state.id), repo, url);
  return url;
}

/** Posts the approved review on its pull request with the verdict of the draft, then records it. */
export async function postReview(id, repo) {
  const state = approvedState(id, 'review');
  const verdict = reviewVerdict(state.id);
  if (!REVIEW_FLAGS[verdict]) throw new Error(`The review draft of ${state.id} has no valid verdict line, so it cannot be posted.`);
  const file = path.join(issueDir(state.id), 'review-body.md');
  fs.writeFileSync(file, reviewBody(state.id));
  try {
    await exec('gh', ['pr', 'review', String(state.issue), '--repo', repo.remote, REVIEW_FLAGS[verdict], '--body-file', file], state.worktree);
  } catch (err) {
    throw new Error(`The review could not be posted: ${err.message}.`);
  } finally {
    fs.rmSync(file, { force: true });
  }
  recordPosted(loadState(state.id), repo);
  return `https://github.com/${repo.remote}/pull/${state.issue}`;
}
