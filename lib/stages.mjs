// Holds the exit rule of every stage and advances an issue when its rule passes.
import fs from 'node:fs';
import path from 'node:path';
import { checkCommits, checkPrBody, commitsOnBranch, prBodyPath } from './checks.mjs';
import { fileSha256, latest, listEvidence, verifyChain } from './evidence.mjs';
import { issueDir } from './paths.mjs';
import { git } from './sh.mjs';
import { REVIEW_STAGES, STAGES } from './pipeline.mjs';
import { head, isDirty, move, saveState, sync } from './state.mjs';
import { resolveWorkflow, saveWorkflow, skips, withLesson, workflowOverride } from './workflow.mjs';
import { addWorkLogLine } from './worklog.mjs';

const read = (id, name) => {
  const file = path.join(issueDir(id), name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};
const field = (text, name) => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(text || '')?.[1].trim() || null;
const hasHeading = (text, name) => new RegExp(`^##\\s+${name}\\s*$`, 'im').test(text || '');

const skipNote = (stage, type) => `Skipped: ${stage} is off for type ${type}.`;

/** Returns each registry gate with the state of its newest record at HEAD. */
export function gateStatus(state, repo, { actor } = {}) {
  const records = listEvidence(state.id);
  const now = head(state);
  return repo.gates.map((g) => {
    const r = latest(records, g.name, (x) => x.kind === 'gate' && (!actor || x.actor === actor));
    let status = 'not-run';
    // A run of another command proves nothing about the gate as it is configured now.
    if (r) status = r.sha !== now || r.dirty || r.cmd !== g.cmd ? 'stale' : r.ok ? 'passed' : 'failed';
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

  triage(state, repo, workflow) {
    const TYPES = workflow.types;
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
      // After the user answered, the agent has to judge again before the task can block a second time.
      const judged = fs.statSync(path.join(issueDir(state.id), 'triage.md')).mtime.toISOString();
      if (state.clarifiedAt && judged <= state.clarifiedAt) {
        return { problems: [`The user answered in ${path.join(issueDir(state.id), 'answers.md')}. Read it, then update triage.md: set "Verdict: clear" when the answers settle it, or keep "unclear" and write the questions that remain in questions.md.`] };
      }
      return { problems: [], block: 'The issue is unclear. questions.md holds the draft for the user to review and post.', kind: 'unclear' };
    }
    return { problems: [], next: 'reproduce' };
  },

  reproduce(state, repo, workflow) {
    if (skips(workflow, 'reproduce', state.type)) return { problems: [], next: 'plan', note: skipNote('reproduce', state.type) };
    const r = latest(listEvidence(state.id), 'reproduce');
    if (!r) {
      return {
        problems: [
          'No reproduction recorded. Run "factory run <id> reproduce --expect-fail -- <command>", or "factory note <id> reproduce <text>" when no command can show it.',
        ],
      };
    }
    if (!r.ok) return { problems: [`The reproduction command exited 0, so it did not show the bug (record ${r.seq}).`] };
    return { problems: [], next: 'plan', note: r.kind === 'manual' ? 'Manual reproduction.' : '' };
  },

  plan(state, repo, workflow) {
    if (skips(workflow, 'plan', state.type)) return { problems: [], next: 'implement', note: skipNote('plan', state.type) };
    const text = read(state.id, 'plan.md');
    if (!text) return { problems: ['plan.md is missing.'] };
    const problems = workflow.stages.plan.headings.filter((h) => !hasHeading(text, h)).map((h) => `plan.md needs a "## ${h}" section.`);
    return { problems, next: 'implement' };
  },

  implement(state) {
    const problems = [];
    if (commitsOnBranch(state).length === 0) problems.push(`No commits on ${state.branch} yet.`);
    if (isDirty(state)) problems.push('The worktree has uncommitted changes. Commit or remove them.');
    return { problems, next: 'gates' };
  },

  gates(state, repo, workflow) {
    const problems = [];
    if (isDirty(state)) problems.push('The worktree has uncommitted changes, so gate evidence would not describe a commit.');
    for (const g of gateStatus(state, repo)) {
      if (g.status !== 'passed') problems.push(`Gate "${g.name}" is ${g.status} at HEAD. Run "factory run ${state.id} ${g.name}".`);
    }
    if (workflow.stages.gates.requireRegression.includes(state.type)) {
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

  verify(state, repo, workflow) {
    const problems = [...checkPrBody(state, repo), ...checkCommits(state, repo)];
    // The PR body and commit checks hold for every type; only the verifier pass can be switched off.
    if (skips(workflow, 'verify', state.type)) return { problems, next: 'ready', note: `Verifier pass skipped: off for type ${state.type}.` };
    const now = head(state);
    const verdict = latest(listEvidence(state.id), 'verdict');
    if (workflow.stages.verify.rerunGates) {
      for (const g of gateStatus(state, repo, { actor: 'verifier' })) {
        if (g.status !== 'passed') problems.push(`The verifier has no passing run of "${g.name}" at HEAD (${g.status}).`);
      }
    }
    if (!verdict || verdict.sha !== now) problems.push('No verifier verdict at HEAD. The factory-verifier agent records it.');
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

// Exit rule of a step the user added: nothing, a document in the task folder, or a recorded command.
function customRule(state, step, workflow) {
  if (skips(workflow, step.id, state.type)) return { problems: [], note: skipNote(step.id, state.type) };
  if (step.check.kind === 'document') {
    const text = read(state.id, step.check.file);
    if (!text?.trim()) return { problems: [`${step.check.file} is missing or empty. Write it to ${path.join(issueDir(state.id), step.check.file)}.`] };
    return { problems: step.check.headings.filter((h) => !hasHeading(text, h)).map((h) => `${step.check.file} needs a "## ${h}" section.`) };
  }
  if (step.check.kind === 'command') {
    const run = latest(listEvidence(state.id), step.id, (r) => r.kind === 'step');
    const again = `Run "factory run ${state.id} ${step.id}".`;
    if (!run) return { problems: [`The check of step "${step.id}" has not run. ${again}`] };
    if (run.sha !== head(state) || run.dirty || run.cmd !== step.check.cmd) return { problems: [`The check of step "${step.id}" is stale: it ran on another commit, a dirty tree or an older command. ${again}`] };
    if (!run.ok) return { problems: [`The check of step "${step.id}" failed (record ${run.seq}). Fix it, commit, then run it again.`] };
  }
  return { problems: [] };
}

/**
 * Counts failed attempts: check runs that failed since the task entered its stage, and failed
 * verdicts on the task. Both restart when a person unblocks the task.
 */
export function attempts(state, workflow = resolveWorkflow(state.repo)) {
  const since = [state.stageSince, state.attemptsResetAt].filter(Boolean).sort().at(-1) || '';
  const records = listEvidence(state.id);
  const runs = records.filter((r) => ['gate', 'step'].includes(r.kind) && !r.ok && r.startedAt >= since).length;
  const verdicts = records.filter((r) => r.kind === 'verdict' && !r.ok && r.startedAt >= (state.attemptsResetAt || '')).length;
  const failed = Math.max(runs, verdicts);
  return { failed, max: workflow.maxAttempts, over: failed >= workflow.maxAttempts, what: verdicts >= runs && verdicts ? 'failed verifier verdicts on this task' : `failed check runs at "${state.stage}"` };
}

/** Blocks the task when its failed attempts reach the cap. Returns the reason, or null. */
export function capAttempts(state) {
  if (state.blocked) return null;
  const count = attempts(state);
  if (!count.over) return null;
  const reason = `${count.failed} ${count.what}; the limit is ${count.max}. A person should look before more attempts.`;
  state.blocked = { reason, kind: 'attempts', at: new Date().toISOString() };
  state.history.push({ stage: 'blocked', at: state.blocked.at, note: reason });
  saveState(state);
  return reason;
}

/** Returns why a task is blocked: "unclear", "attempts" or "other". Older tasks carry no kind. */
export function blockKind(state) {
  if (!state.blocked) return null;
  if (state.blocked.kind) return state.blocked.kind;
  if (/^The issue is unclear/.test(state.blocked.reason)) return 'unclear';
  return /failed (check runs|verifier verdicts)/.test(state.blocked.reason) ? 'attempts' : 'other';
}

/**
 * Lets a blocked task continue. The user's answer or note is appended to answers.md in the task
 * folder, and the next brief points the agent at it.
 */
export function unblock(state, { note = '' } = {}) {
  if (!state.blocked) throw new Error(`${state.id} is not blocked.`);
  const text = String(note ?? '').trim();
  if (text.length > 4000) throw new Error('The answer is longer than 4000 characters. Shorten it, or put the detail on the issue.');
  const at = new Date().toISOString();
  const kind = blockKind(state);
  const entry = text || (kind === 'unclear' ? 'The user decided the issue is clear enough to proceed. Use your best reading of it and state the assumptions in the plan.' : '');
  if (entry) {
    const file = path.join(issueDir(state.id), 'answers.md');
    fs.appendFileSync(file, `${fs.existsSync(file) ? '\n' : ''}## ${at}\n\n${entry}\n`);
    state.clarifiedAt = at;
  }
  state.blocked = null;
  // Failed attempts are counted from here again.
  state.attemptsResetAt = at;
  state.history.push({ stage: state.stage, at, note: text ? `Unblocked with an answer: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}` : 'Unblocked.' });
  saveState(state);
  return state;
}

/**
 * Sends a task at human review back for more work, with the reason. A lesson is added to the
 * project's workflow, so later briefs carry it.
 */
export function sendBack(state, repo, { reason, lesson = '' }) {
  sync(state);
  if (state.stage !== 'ready') throw new Error(`${state.id} is at "${state.stage}", not at human review. Only a task waiting for your review can be sent back.`);
  const why = String(reason ?? '').trim();
  if (!why || why.length > 1000) throw new Error('Sending a task back needs a reason of at most 1000 characters: what is wrong, so the agent can fix it.');
  const learned = String(lesson ?? '').trim();
  if (/[\r\n]/.test(learned) || learned.length > 300) throw new Error('The lesson must be one line of at most 300 characters.');
  if (learned) {
    const override = workflowOverride(repo.key);
    saveWorkflow(repo.key, { ...override, lessons: withLesson(override.lessons || resolveWorkflow(repo.key).lessons, learned) });
  }
  state.gatesSha = null;
  state.approvedSha = null;
  state.approvedDraftSha256 = null;
  state.attemptsResetAt = new Date().toISOString();
  move(state, state.kind === 'review' ? 'draft' : 'implement', `Sent back at human review: ${why}`);
  state.sentBack = { reason: why, at: state.stageSince };
  saveState(state);
  return state;
}

// Returns the outcome of the current stage's exit rule and the stage that follows it.
function evaluate(state, repo) {
  const workflow = resolveWorkflow(repo.key);
  if (state.kind === 'review') return { result: reviewRules[state.stage](state, repo, workflow), order: REVIEW_STAGES };
  const { order } = workflow;
  const step = workflow.customStages.find((item) => item.id === state.stage);
  if (order.includes(state.stage)) return { result: step ? customRule(state, step, workflow) : rules[state.stage](state, repo, workflow), order };
  // The stage left the workflow while the task was in it: continue after the last stage that still exists.
  const passed = [...state.history].reverse().map((h) => h.stage).find((stage) => stage !== state.stage && order.includes(stage)) || STAGES[Math.max(STAGES.indexOf(state.stage) - 1, 0)];
  return { result: { problems: [], note: `Skipped: ${state.stage} was removed from the workflow.` }, order, from: order.includes(passed) ? passed : 'triage' };
}

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

/** Returns a key of what an approval covers: HEAD plus the review draft or the PR body. */
export function approvalKey(state) {
  const file = state.kind === 'review' ? reviewPath(state.id) : prBodyPath(state.id);
  return `${head(state)}:${fs.existsSync(file) ? fileSha256(file) : 'none'}`;
}

/** Moves a ready issue to approved and binds the approval to HEAD. */
export function approve(state) {
  sync(state);
  if (state.stage !== 'ready') {
    throw new Error(`${state.id} is at "${state.stage}", not "ready". Approval needs passing gates, a verifier pass and a valid PR body at HEAD.`);
  }
  state.approvedSha = head(state);
  if (state.kind === 'review') state.approvedDraftSha256 = fileSha256(reviewPath(state.id));
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

/** Returns what the exit rule of the current stage still misses, without changing the task. */
export function inspect(state, repo) {
  if (state.blocked) return { blocked: state.blocked.reason, problems: [], attempts: null };
  const tampered = verifyChain(state.id);
  if (tampered.length) return { blocked: null, problems: tampered.map((p) => `Evidence integrity: ${p}`), attempts: null };
  const { result } = evaluate(structuredClone(state), repo);
  return { blocked: null, problems: result.block ? [result.block] : result.problems, attempts: attempts(state) };
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

  const capped = capAttempts(state);
  if (capped) return { moved: false, stage: state.stage, problems: [`Blocked: ${capped} Clear it with "factory unblock ${state.id}".`] };
  const { result, order, from } = evaluate(state, repo);
  if (result.block) {
    state.blocked = { reason: result.block, kind: result.kind || 'other', at: new Date().toISOString() };
    state.history.push({ stage: 'blocked', at: state.blocked.at, note: result.block });
    saveState(state);
    return { moved: false, stage: state.stage, problems: [result.block] };
  }
  if (result.problems.length) {
    saveState(state);
    return { moved: false, stage: state.stage, problems: result.problems };
  }
  const next = order[order.indexOf(from || state.stage) + 1];
  if (!next) throw new Error(`No stage follows "${state.stage}" for ${state.id}.`);
  move(state, next, result.note || '');
  if (state.kind !== 'review' && next === 'ready' && !state.logged?.ready) {
    addWorkLogLine(state, repo, 'ready for review, not pushed');
    state.logged = { ...state.logged, ready: true };
  }
  saveState(state);
  return { moved: true, stage: state.stage, problems: [] };
}
