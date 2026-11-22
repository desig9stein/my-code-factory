// The work the board server hands to its worker threads. Every job takes plain data and returns plain data.
// A job that changes a task loads it inside the task's lock, so it never writes from an old copy.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMainThread, parentPort } from 'node:worker_threads';
import { agentsOverview, readRun } from './agents.mjs';
import { boardScript, writeBoard } from './board.mjs';
import { mergeBase } from './checks.mjs';
import { pendingProjects } from './config.mjs';
import { fetchFeedback, sendFeedback } from './followup.mjs';
import { commentFromFile, repoPeople, searchIssues, withTasks } from './github.mjs';
import { hooksInstalled, installAgentFiles, installHooks } from './hooks.mjs';
import { withTask } from './lock.mjs';
import { factoryRoot, issueDir, workspace } from './paths.mjs';
import { getRepo } from './registry.mjs';
import { dayFacts } from './report.mjs';
import { addProject, discoverProjects, locateProject, preflight, removeProject, updateProject } from './setup.mjs';
import { approvalKey, approve, archive, recordPr, sendBack, unblock } from './stages.mjs';
import { loadState, saveState, sync } from './state.mjs';

const CHANGED = 'This changed since the board showed it. Read it again, then decide.';

export const JOBS = {
  // ----- local lane -----
  board: () => boardScript(),
  writeBoard: () => { writeBoard(); },
  diff({ id }) {
    const state = loadState(id);
    const result = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', `${mergeBase(state)}..HEAD`], { cwd: state.worktree, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.error?.code === 'ENOBUFS' ? 'Diff exceeds 2 MB. Inspect it in your Git client.' : 'Could not read the committed diff. Check that the worktree exists.');
    return { diff: result.stdout };
  },
  withTasks: ({ issues }) => withTasks(issues),
  // Looking for projects and changing one asks Git about each folder.
  candidates: () => discoverProjects(),
  projectLocate: ({ dir }) => locateProject(dir),
  projectUpdate({ key, patch }) { updateProject(key, patch); writeBoard(); },
  // locateProject repeats the checks the page ran: a real repository root with a GitHub origin, not registered yet.
  projectAdd({ key, dir, options }) { addProject(key, locateProject(dir).dir, options); writeBoard(); },
  projectRemove({ key }) { removeProject(key); writeBoard(); },
  archive({ id, deleteBranch }) {
    withTask(id, () => {
      const state = loadState(id);
      // Archiving removes the worktree; an agent working in it would lose its folder mid-step.
      if (['running', 'queued'].includes(readRun(state.id)?.status)) throw new Error(`An agent runs on ${state.id}, or waits to. Stop it first, then archive.`);
      archive(state, getRepo(state.repo), { deleteBranch });
    });
    writeBoard();
  },
  recordPr({ id, url }) {
    withTask(id, () => {
      const state = sync(loadState(id));
      recordPr(state, getRepo(state.repo), url);
    });
    writeBoard();
  },
  unblock({ id, note }) {
    withTask(id, () => unblock(loadState(id), { note }));
    writeBoard();
  },
  // Approving and sending back cover the version the page showed; any other version is refused.
  reject({ id, key, reason, lesson }) {
    const done = withTask(id, () => {
      const state = sync(loadState(id));
      if (key !== approvalKey(state)) return false;
      sendBack(state, getRepo(state.repo), { reason, lesson });
      return true;
    });
    if (done) writeBoard();
    return done ? { ok: true } : { conflict: CHANGED };
  },
  approve({ id, key }) {
    const done = withTask(id, () => {
      const state = sync(loadState(id));
      if (key !== approvalKey(state)) return false;
      approve(state);
      return true;
    });
    if (done) writeBoard();
    return done ? { ok: true } : { conflict: 'This changed since the board showed it. Read it again, then approve.' };
  },
  // The comment went out on the "net" lane; this records it on the task.
  questionsPosted({ id, url, sha }) {
    const posted = withTask(id, () => {
      const state = loadState(id);
      state.questionsPosted = { at: new Date().toISOString(), url: /^https:\/\//.test(url) ? url : null, sha: typeof sha === 'string' ? sha : null };
      state.history.push({ stage: state.stage, at: state.questionsPosted.at, note: `Questions posted on the issue by the user.${state.questionsPosted.url ? ` ${state.questionsPosted.url}` : ''}` });
      saveState(state);
      return state.questionsPosted;
    });
    writeBoard();
    return posted;
  },

  // Adds the guard hooks, the skill and the verifier agent to the user's Claude Code settings.
  installHooks() {
    const hooks = installHooks();
    const files = installAgentFiles();
    return { file: hooks.file, changed: hooks.changed || files.some((file) => file.changed), backup: hooks.backup };
  },
  sendFeedback({ id, text }) {
    sendFeedback(id, text);
    writeBoard();
  },

  // ----- net lane -----
  prFeedback: ({ id }) => { fetchFeedback(id); },
  setup: () => ({ root: factoryRoot(), workspace: workspace(), checks: preflight(), candidates: discoverProjects(), pending: Object.entries(pendingProjects()).map(([key, entry]) => ({ key, remote: entry.remote })), hooksInstalled: hooksInstalled() }),
  issues: ({ filter }) => searchIssues(filter),
  report: ({ day }) => dayFacts(day),
  people: ({ remote }) => repoPeople(remote),
  agents: () => agentsOverview(),
  // Posts the drafted questions on the issue, only the text the page showed.
  postQuestions({ id, sha }) {
    const state = loadState(id);
    const file = path.join(issueDir(state.id), 'questions.md');
    if (!fs.existsSync(file)) throw new Error(`${state.id} has no drafted questions.`);
    // The same text goes on the issue once, however often the button is pressed.
    if (state.questionsPosted?.sha && state.questionsPosted.sha === sha) return { conflict: 'These questions are on the issue already.' };
    if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha) return { conflict: 'The questions changed since the board showed them. Read them again, then post.' };
    return { url: commentFromFile(getRepo(state.repo).remote, state.issue, file) };
  },
};

// As a worker thread: take jobs from the server and answer each with its result or its error.
if (!isMainThread && parentPort) {
  parentPort.on('message', async ({ id, job, args }) => {
    try {
      if (!Object.hasOwn(JOBS, job)) throw new Error(`Unknown job "${job}".`);
      parentPort.postMessage({ id, ok: true, result: await JOBS[job](args) });
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: String(err?.message || err) });
    }
  });
}
