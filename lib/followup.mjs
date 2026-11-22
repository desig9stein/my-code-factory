// Follows a pull request after it is opened: what its checks say and what reviewers wrote. The user decides
// which of it goes to the agent; nothing a stranger writes on GitHub reaches an agent by itself.
import fs from 'node:fs';
import path from 'node:path';
import { withTask } from './lock.mjs';
import { issueDir } from './paths.mjs';
import { run } from './sh.mjs';
import { loadState, move, saveState } from './state.mjs';
import { writeJson } from './store.mjs';

const MAX_ITEMS = 40;
const MAX_BODY = 2000;
const MAX_TEXT = 6000;
const PR = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/i;
// Check results that mean "this did not pass".
const FAILED = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'];
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];

const feedbackPath = (id) => path.join(issueDir(id), 'pr-feedback.json');
const text = (value, max = MAX_BODY) => String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
const link = (value) => (/^https:\/\/github\.com\//i.test(String(value || '')) ? String(value) : null);

function gh(args) {
  const result = run('gh', args);
  if (result.status !== 0) throw new Error(result.stderr.trim().split('\n')[0] || 'gh failed');
  let answer = null;
  try {
    answer = JSON.parse(result.stdout || 'null');
  } catch {
    // Said below.
  }
  // A proxy page or an empty answer is not GitHub's answer.
  if (!answer || typeof answer !== 'object') throw new Error('the answer was not what GitHub sends');
  return answer;
}

/** Turns what GitHub reports about a pull request into the few things the board shows. */
export function readFeedback(view, inline = []) {
  const author = view.author?.login || '';
  // A deleted account has no name left; what it wrote still counts.
  const who = (person) => text(person?.login, 60) || 'a deleted account';
  const checks = (Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : []).map((check) => {
    // A check run reports a conclusion once it is done; a commit status reports a state.
    const result = String(check.conclusion || check.state || '').toUpperCase();
    const done = check.conclusion || (check.state && !['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(String(check.state).toUpperCase()));
    return { name: text(check.name || check.context || 'check', 100), result: !done ? 'pending' : FAILED.includes(result) ? 'failed' : PASSED.includes(result) ? 'passed' : 'pending', url: link(check.detailsUrl || check.targetUrl) };
  });
  // What the author of the pull request wrote is not feedback on it.
  const others = (login) => !login || login !== author;
  const all = [
    ...(Array.isArray(view.reviews) ? view.reviews : []).filter((r) => others(r.author?.login) && (text(r.body) || ['CHANGES_REQUESTED', 'APPROVED'].includes(r.state))).map((r) => ({ kind: r.state === 'CHANGES_REQUESTED' ? 'changes requested' : r.state === 'APPROVED' ? 'approved' : 'review', author: who(r.author), body: text(r.body), at: r.submittedAt || null, url: link(r.url), path: null, line: null })),
    ...(Array.isArray(view.comments) ? view.comments : []).filter((c) => others(c.author?.login) && text(c.body)).map((c) => ({ kind: 'comment', author: who(c.author), body: text(c.body), at: c.createdAt || null, url: link(c.url), path: null, line: null })),
    ...(Array.isArray(inline) ? inline : []).filter((c) => others(c.user?.login) && text(c.body)).map((c) => ({ kind: 'comment on a line', author: who(c.user), body: text(c.body), at: c.created_at || null, url: link(c.html_url), path: text(c.path, 300) || null, line: Number.isInteger(c.line) ? c.line : null })),
  ].filter((note) => note.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const notes = all.slice(-MAX_ITEMS);
  return {
    state: view.state === 'MERGED' || view.mergedAt ? 'merged' : view.state === 'CLOSED' ? 'closed' : 'open',
    head: text(view.headRefOid, 64) || null,
    decision: text(view.reviewDecision, 40) || null,
    checks: checks.slice(0, MAX_ITEMS),
    notes,
    // What did not fit is counted, so the board can say that there is more on GitHub.
    omitted: { notes: all.length - notes.length, checks: Math.max(0, checks.length - MAX_ITEMS) },
  };
}

/** Asks GitHub about the task's pull request and stores the answer beside the task. Returns what was stored. */
export function fetchFeedback(id) {
  const state = loadState(id);
  const match = PR.exec(state.prUrl || '');
  if (!match) throw new Error(`${id} has no pull request recorded.`);
  let stored;
  try {
    const view = gh(['pr', 'view', state.prUrl, '--json', 'state,mergedAt,author,headRefOid,reviewDecision,statusCheckRollup,reviews,comments']);
    let inline = [];
    try {
      inline = gh(['api', `repos/${match[1]}/pulls/${match[2]}/comments`, '--paginate']);
    } catch {
      // The comments on lines are an extra; the review bodies and the checks still tell the story.
    }
    stored = { ...readFeedback(view, inline), fetchedAt: new Date().toISOString(), error: null };
  } catch (err) {
    // The last good answer stays on screen, with the reason the newest one is missing.
    stored = { ...(storedFeedback(id) || { state: 'open', head: null, decision: null, checks: [], notes: [] }), error: `GitHub could not be asked: ${err.message}`, triedAt: new Date().toISOString() };
  }
  writeJson(feedbackPath(id), stored);
  return stored;
}

function storedFeedback(id) {
  try {
    const stored = JSON.parse(fs.readFileSync(feedbackPath(id), 'utf8'));
    return stored && typeof stored === 'object' && Array.isArray(stored.checks) && Array.isArray(stored.notes) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Returns what the board shows of a task's pull request, or null before the first answer.
 * `needsYou` is true when a check failed or someone wrote after the user last sent feedback to the agent.
 */
export function feedbackView(state) {
  if (!state.prUrl || !['pr-opened', 'implement', 'gates', 'verify', 'ready', 'approved'].includes(state.stage)) return null;
  const stored = storedFeedback(state.id);
  if (!stored) return null;
  const since = state.prFeedbackSentAt || '';
  const sameCommit = !stored.head || !state.approvedSha || stored.head === state.approvedSha;
  // An answer from before the pull request was last updated is about the commit before: its checks say nothing
  // about the one pushed since. An answer from after it that names another commit means the pull request moved on
  // GitHub (a suggestion committed there, "Update branch"): those checks are real, and are shown with that said.
  const before = Boolean(stored.fetchedAt && state.stage === 'pr-opened' && state.stageSince && stored.fetchedAt < state.stageSince);
  const outdated = !sameCommit && (before || state.stage !== 'pr-opened');
  const fresh = stored.notes.filter((note) => String(note.at) > since && note.kind !== 'approved');
  const failed = outdated ? [] : stored.checks.filter((check) => check.result === 'failed');
  const waiting = state.stage === 'pr-opened' && stored.state === 'open';
  return {
    state: stored.state,
    decision: stored.decision,
    failed,
    pending: outdated ? 0 : stored.checks.filter((check) => check.result === 'pending').length,
    passed: outdated ? 0 : stored.checks.filter((check) => check.result === 'passed').length,
    // True when the stored answer is older than the last update: the checks are not known until GitHub is asked again.
    outdated,
    // True when GitHub's pull request is at a commit Codeignite did not push.
    movedOnGitHub: !sameCommit && !outdated,
    omitted: stored.omitted || { notes: 0, checks: 0 },
    notes: fresh,
    approvals: stored.notes.filter((note) => note.kind === 'approved').length,
    fetchedAt: stored.fetchedAt || null,
    error: stored.error || null,
    needsYou: waiting && (failed.length > 0 || fresh.length > 0),
    // The text offered to the user to send, which they may change first.
    draft: waiting ? feedbackDraft(failed, fresh) : '',
  };
}

function feedbackDraft(failed, notes) {
  const lines = [];
  if (failed.length) lines.push('Checks that failed on the pull request:', ...failed.map((check) => `- ${check.name}${check.url ? ` (${check.url})` : ''}`), '');
  if (notes.length) lines.push('Review feedback:', ...notes.map((note) => `- ${note.author}${note.path ? `, ${note.path}${note.line ? `:${note.line}` : ''}` : ''}: ${note.body.replace(/\s+/g, ' ') || note.kind}`));
  const whole = lines.join('\n').trim();
  if (whole.length <= MAX_TEXT) return whole;
  // Cut between items, and say that it was cut.
  const kept = whole.slice(0, MAX_TEXT - 80);
  return `${kept.slice(0, Math.max(kept.lastIndexOf('\n'), 0)) || kept}\n- (More is on the pull request; this list was cut to fit.)`;
}

/**
 * Sends the task back to the agent with the user's text about the pull request. The fix goes through the
 * checks, the verifier and the user's approval again before the pull request is updated.
 */
export function sendFeedback(id, input) {
  const what = text(input, MAX_TEXT + 1);
  if (!what || what.length > MAX_TEXT) throw new Error(`Say what the agent should fix, in at most ${MAX_TEXT} characters.`);
  return withTask(id, () => {
    const state = loadState(id);
    if (state.archived) throw new Error(`${id} is archived, so there is no folder left for an agent to work in.`);
    if (state.kind === 'review' || state.stage !== 'pr-opened') throw new Error(`${id} is at "${state.stage}". Feedback on a pull request is sent when the pull request is open.`);
    const stored = storedFeedback(id);
    if (stored && stored.state !== 'open') throw new Error(`The pull request of ${id} is ${stored.state}, so there is nothing left to fix on it.`);
    const at = new Date().toISOString();
    state.prFeedback = { text: what, at };
    // What the user saw is marked as passed on: the newest note of the answer the board showed, in GitHub's own
    // time. A note written after that answer was fetched was never on screen and stays new.
    const seen = (stored?.notes || []).map((note) => String(note.at)).sort().at(-1);
    state.prFeedbackSentAt = [seen, state.prFeedbackSentAt].filter(Boolean).sort().at(-1) || '';
    state.gatesSha = null;
    state.approvedSha = null;
    state.approvedDraftSha256 = null;
    state.attemptsResetAt = at;
    move(state, 'implement', 'Sent back with feedback from the pull request.');
    saveState(state);
    return state;
  });
}
