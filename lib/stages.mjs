// Holds the exit rule of every stage and advances an issue when its rule passes.
import fs from 'node:fs';
import path from 'node:path';
import { checkCommits, checkPrBody, commitsOnBranch, prBodyPath } from './checks.mjs';
import { fileSha256, latest, listEvidence, verifyChain } from './evidence.mjs';
import { issueDir } from './paths.mjs';
import { git } from './sh.mjs';
import { head, isDirty, move, saveState, stagesOf, sync } from './state.mjs';
import { addWorkLogLine } from './worklog.mjs';

const read = (id, name) => {
  const file = path.join(issueDir(id), name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};
const field = (text, name) => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(text || '')?.[1].trim() || null;
const hasHeading = (text, name) => new RegExp(`^##\\s+${name}\\s*$`, 'im').test(text || '');

const TYPES = ['bug', 'feature', 'docs', 'chore'];
const PLAN_HEADINGS = ['Files', 'Tests', 'Consumer impact', 'Changelog'];

/** Returns each registry gate with the state of its newest record at HEAD. */
export function gateStatus(state, repo, { actor } = {}) {
  const records = listEvidence(state.id);
  const now = head(state);
  return repo.gates.map((g) => {
    const r = latest(records, g.name, (x) => x.kind === 'gate' && (!actor || x.actor === actor));
    let status = 'not-run';
    if (r) status = r.sha !== now || r.dirty ? 'stale' : r.ok ? 'passed' : 'failed';
    return { name: g.name, cmd: g.cmd, status, seq: r?.seq ?? null };
  });
}

/** Returns the state of the regression proof at HEAD: passed, manual, failed, stale or missing. */
export function regressStatus(state) {
  const records = listEvidence(state.id);
  const now = head(state);
  const base = latest(records, 'regress-base');
  const fix = latest(records, 'regress-fix');
  const manual = latest(records, 'regress', (r) => r.kind === 'manual');
  if (base && fix && fix.seq > base.seq) {
    if (base.sha !== now || fix.sha !== now) return manual?.sha === now ? 'manual' : 'stale';
    return base.ok && fix.ok ? 'passed' : 'failed';
  }
  if (manual) return manual.sha === now ? 'manual' : 'stale';
  return 'missing';
}

const rules = {
  intake(state) {
    const problems = [];
    if (!read(state.id, 'issue.md')) problems.push('issue.md is missing; the issue snapshot was not fetched.');
    if (!head(state)) problems.push(`The worktree at ${state.worktree} is missing.`);
    return { problems, next: 'triage' };
  },

  triage(state) {
    const text = read(state.id, 'triage.md');
    if (!text) return { problems: ['triage.md is missing. It needs "Type:", "Scope:" and "Verdict:" lines.'] };
    const problems = [];
    const type = field(text, 'Type')?.toLowerCase();
    const verdict = field(text, 'Verdict')?.toLowerCase();
    if (!TYPES.includes(type)) problems.push(`triage.md "Type:" must be one of ${TYPES.join(', ')}; got "${type}".`);
    if (!field(text, 'Scope')) problems.push('triage.md needs a "Scope:" line naming what changes and what stays out.');
    if (!['clear', 'unclear'].includes(verdict)) problems.push(`triage.md "Verdict:" must be clear or unclear; got "${verdict}".`);
    if (problems.length) return { problems };
    state.type = type;
    if (verdict === 'unclear') {
      if (!read(state.id, 'questions.md')) {
        return { problems: ['Verdict is unclear: draft the follow-up questions in questions.md. Nothing is posted.'] };
      }
      return { problems: [], block: 'The issue is unclear. questions.md holds the draft for the user to review and post.' };
    }
    return { problems: [], next: 'reproduce' };
  },

  reproduce(state) {
    if (state.type !== 'bug') return { problems: [], next: 'plan', note: `Skipped: type is ${state.type}.` };
    const r = latest(listEvidence(state.id), 'reproduce');
    if (!r) {
      return {
        problems: [
          'No reproduction recorded. Run "factory run <id> reproduce --expect-fail -- <command>", or "factory note <id> reproduce <text>" when no command can show it.',
        ],
      };
    }
    if (r.kind !== 'manual' && r.expect !== 'fail') {
      return { problems: [`Record ${r.seq} ran without --expect-fail, so a passing command would count. Run "factory run ${state.id} reproduce --expect-fail -- <command>".`] };
    }
    if (!r.ok) return { problems: [`The reproduction command exited 0, so it did not show the bug (record ${r.seq}).`] };
    return { problems: [], next: 'plan', note: r.kind === 'manual' ? 'Manual reproduction.' : '' };
  },

  plan(state) {
    const text = read(state.id, 'plan.md');
    if (!text) return { problems: ['plan.md is missing.'] };
    const problems = PLAN_HEADINGS.filter((h) => !hasHeading(text, h)).map((h) => `plan.md needs a "## ${h}" section.`);
    return { problems, next: 'implement' };
  },

  implement(state) {
    const problems = [];
    if (commitsOnBranch(state).length === 0) problems.push(`No commits on ${state.branch} yet.`);
    if (isDirty(state)) problems.push('The worktree has uncommitted changes. Commit or remove them.');
    return { problems, next: 'gates' };
  },

  gates(state, repo) {
    const problems = [];
    if (isDirty(state)) problems.push('The worktree has uncommitted changes, so gate evidence would not describe a commit.');
    for (const g of gateStatus(state, repo)) {
      if (g.status !== 'passed') problems.push(`Gate "${g.name}" is ${g.status} at HEAD. Run "factory run ${state.id} ${g.name}".`);
    }
    if (state.type === 'bug') {
      const rs = regressStatus(state);
      if (rs !== 'manual' && rs !== 'passed') {
        problems.push(
          repo.testable === false
            ? `No regression check at HEAD (${rs}). ${repo.key} has no test suite: record what was checked with "factory note ${state.id} regress <text>".`
            : `Regression proof is ${rs} at HEAD. Run "factory regress ${state.id} --tests <paths> -- <test command>".`,
        );
      }
    }
    if (!problems.length) state.gatesSha = head(state);
    return { problems, next: 'verify' };
  },

  verify(state, repo) {
    const problems = [];
    const now = head(state);
    const verdict = latest(listEvidence(state.id), 'verdict');
    for (const g of gateStatus(state, repo, { actor: 'verifier' })) {
      if (g.status !== 'passed') problems.push(`The verifier has no passing run of "${g.name}" at HEAD (${g.status}).`);
    }
    problems.push(...checkPrBody(state, repo), ...checkCommits(state, repo));
    if (!verdict || verdict.sha !== now) problems.push(`No verifier verdict at HEAD. An independent verifier records it with "factory verdict ${state.id} pass|fail --report <file>".`);
    else if (verdict.dirty) problems.push(`The verdict (record ${verdict.seq}) was recorded on a tree with uncommitted changes, so it does not describe the commit. Clean the worktree and record it again.`);
    else if (!verdict.ok) problems.push(`The verifier verdict is "fail" (record ${verdict.seq}). Fix the findings in verify.md.`);
    else if (fs.existsSync(prBodyPath(state.id)) && verdict.prBodySha256 !== fileSha256(prBodyPath(state.id))) {
      problems.push('pr-body.md changed after the verdict. The verifier must judge the new text.');
    }
    return { problems, next: 'ready' };
  },

  ready() {
    return { problems: ['Waiting for the user. Approval is "factory approve <id>" in a terminal.'] };
  },

  approved(state) {
    if (!state.prUrl) return { problems: ['No PR recorded. After the push, run "factory pr <id> <url>".'] };
    return { problems: [], next: 'pr-opened' };
  },

  'pr-opened'() {
    return { problems: ['The PR is open. Nothing follows this stage; archive the issue once it merges.'] };
  },
};

export const reviewPath = (id) => path.join(issueDir(id), 'review.md');
const REVIEW_VERDICTS = ['approve', 'request-changes', 'comment'];

/** Returns the verdict line of the review draft, or null. */
export function reviewVerdict(id) {
  const verdict = field(read(id, 'review.md'), 'Verdict')?.toLowerCase();
  return REVIEW_VERDICTS.includes(verdict) ? verdict : null;
}

// Exit rules for a pull request under review.
const reviewRules = {
  intake(state) {
    const problems = [];
    if (!read(state.id, 'pr.md')) problems.push('pr.md is missing; the PR snapshot was not fetched.');
    if (!head(state)) problems.push(`The worktree at ${state.worktree} is missing.`);
    return { problems, next: 'checks' };
  },

  checks(state, repo) {
    const problems = [];
    if (isDirty(state)) problems.push('The worktree has uncommitted changes, so the checks would not describe the PR head.');
    for (const g of gateStatus(state, repo)) {
      if (g.status === 'not-run' || g.status === 'stale') problems.push(`Gate "${g.name}" is ${g.status} at the PR head. Run "factory run ${state.id} ${g.name} --as reviewer".`);
    }
    if (!problems.length) state.gatesSha = head(state);
    return { problems, next: 'draft' };
  },

  draft(state, repo) {
    const text = read(state.id, 'review.md');
    if (!text) return { problems: [`review.md is missing. Write the draft review to ${reviewPath(state.id)}.`] };
    const problems = [];
    if (!reviewVerdict(state.id)) problems.push(`review.md needs a first line "Verdict: ${REVIEW_VERDICTS.join(' | ')}".`);
    if (text.trim().length < 200) problems.push('review.md is too short to be a review. Say what is right, then list the findings with file:line and evidence.');
    if (repo.forbidAiAttribution === true && /co-authored-by|generated with|claude code|🤖/i.test(text)) problems.push('The review carries AI attribution. Remove the line.');
    return { problems, next: 'ready' };
  },

  ready() {
    return { problems: ['Waiting for the user to read the draft. Approval is "factory approve <id>" in a terminal.'] };
  },

  approved(state) {
    return { problems: [`After the review is posted, run "factory posted ${state.id}".`] };
  },

  posted() {
    return { problems: ['The review is posted. Run "factory refresh <id>" after new pushes, or archive it.'] };
  },
};

/** Marks an approved review as posted. */
export function recordPosted(state, repo) {
  sync(state);
  if (state.kind !== 'review' || state.stage !== 'approved') throw new Error(`${state.id} is at "${state.stage}", not an approved review.`);
  move(state, 'posted', `Review "${reviewVerdict(state.id)}" posted.`);
  addWorkLogLine(state, repo, `review posted (${reviewVerdict(state.id)})`);
  saveState(state);
  return state;
}

/** Returns the review body to post: review.md without its verdict line. */
export function reviewBody(id) {
  return (read(id, 'review.md') || '').replace(/^Verdict:.*\n+/i, '');
}

/** Removes the worktree, optionally the local branch, and hides the issue from the board. */
export function archive(state, repo, { deleteBranch = false } = {}) {
  if (fs.existsSync(state.worktree)) {
    if (isDirty(state)) throw new Error(`The worktree of ${state.id} has uncommitted changes. Commit or discard them first.`);
    git(repo.dir, 'worktree', 'remove', state.worktree);
  }
  if (deleteBranch && state.kind !== 'review') git(repo.dir, 'branch', '-D', state.branch);
  state.archived = true;
  state.history.push({ stage: 'archived', at: new Date().toISOString(), note: deleteBranch ? `Local branch ${state.branch} deleted.` : '' });
  saveState(state);
  return state;
}

// The text an approval covers: the review draft, or the PR body of an issue.
const draftPath = (state) => (state.kind === 'review' ? reviewPath(state.id) : prBodyPath(state.id));

/** Returns a key of what an approval covers: HEAD plus the review draft or the PR body. */
export function approvalKey(state) {
  const file = draftPath(state);
  return `${head(state)}:${fs.existsSync(file) ? fileSha256(file) : 'none'}`;
}

/**
 * Returns true while the approval still describes HEAD and the approved text.
 * An issue approved before the PR body hash was stored has no hash to compare, so only its commit is checked.
 */
export function approvalIntact(state) {
  if (!state.approvedSha || state.approvedSha !== head(state)) return false;
  const stages = state.kind === 'review' ? ['approved', 'posted'] : ['approved', 'pr-opened'];
  if (!stages.includes(state.stage)) return false;
  if (state.kind !== 'review' && state.approvedDraftSha256 == null) return true;
  const file = draftPath(state);
  return fs.existsSync(file) && fileSha256(file) === state.approvedDraftSha256;
}

/** Moves a ready issue to approved and binds the approval to HEAD. */
export function approve(state) {
  sync(state);
  if (state.stage !== 'ready') {
    throw new Error(`${state.id} is at "${state.stage}", not "ready". Approval needs passing gates, a verifier pass and a valid PR body at HEAD.`);
  }
  const draft = draftPath(state);
  if (!fs.existsSync(draft)) throw new Error(`${path.basename(draft)} is missing, so there is no text to approve.`);
  state.approvedSha = head(state);
  state.approvedDraftSha256 = fileSha256(draft);
  move(state, 'approved', `Approved at ${state.approvedSha.slice(0, 8)}.`);
  saveState(state);
  return state;
}

/** Records the PR URL of an approved issue and moves it to pr-opened. */
export function recordPr(state, repo, url) {
  sync(state);
  if (state.stage !== 'approved') throw new Error(`${state.id} is at "${state.stage}", not "approved".`);
  if (!new RegExp(`^https://github\\.com/${repo.remote}/pull/\\d+$`, 'i').test(url)) {
    throw new Error(`Expected a PR URL like https://github.com/${repo.remote}/pull/123, got "${url}".`);
  }
  const first = !state.prUrl;
  state.prUrl = url;
  move(state, 'pr-opened', url);
  addWorkLogLine(state, repo, first ? 'opened, awaiting review' : 'updated after review');
  saveState(state);
  return state;
}

/**
 * Checks the exit rule of the current stage and moves on when it passes.
 * Returns { moved, stage, problems }.
 */
export function advance(state, repo) {
  sync(state);
  if (state.blocked) {
    return { moved: false, stage: state.stage, problems: [`Blocked: ${state.blocked.reason} Clear it with "factory unblock ${state.id}".`] };
  }
  const tampered = verifyChain(state.id);
  if (tampered.length) return { moved: false, stage: state.stage, problems: tampered.map((p) => `Evidence integrity: ${p}`) };

  const result = (state.kind === 'review' ? reviewRules : rules)[state.stage](state, repo);
  if (result.block) {
    state.blocked = { reason: result.block, at: new Date().toISOString() };
    state.history.push({ stage: 'blocked', at: state.blocked.at, note: result.block });
    saveState(state);
    return { moved: false, stage: state.stage, problems: [result.block] };
  }
  if (result.problems.length) {
    saveState(state);
    return { moved: false, stage: state.stage, problems: result.problems };
  }
  move(state, result.next, result.note || '');
  if (!stagesOf(state).includes(result.next)) throw new Error(`Stage "${result.next}" does not exist for ${state.id}.`);
  if (state.kind !== 'review' && result.next === 'ready' && !state.logged?.ready) {
    addWorkLogLine(state, repo, 'ready for review, not pushed');
    state.logged = { ...state.logged, ready: true };
  }
  saveState(state);
  return { moved: true, stage: state.stage, problems: [] };
}
