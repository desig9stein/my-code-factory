// Serves the board on 127.0.0.1 and runs its approve, archive, project and issue-filter actions.
import { withSettings } from './lock.mjs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { agentSettings, createRunner, saveAgentSettings } from './agents.mjs';
import { boardTemplate, writeBoard } from './board.mjs';
import { createLanes } from './offload.mjs';
import { createPairing, unpairedPage } from './pairing.mjs';
import { acceptProposals, dismissProposals, proposeForProject, proposeGlobal, userAssets } from './assets.mjs';
import { issueFilter, saveIssueFilter, withTasks } from './github.mjs';
import { declareDetectedLinks } from './graph.mjs';
import { hooksInstalled } from './hooks.mjs';
import { codeRoot, factoryRoot, issueDir, issuesDir, within, workspace } from './paths.mjs';
import { boardPort } from './port.mjs';
import { createPullRequest, postReview } from './publish.mjs';
import { modelChoices } from './providers.mjs';
import { getRepo, loadRegistry } from './registry.mjs';
import { writePlainReport } from './report.mjs';
import { addProject, discoverProjects, locateProject, removeProject, saveRegistry, updateProject } from './setup.mjs';
import { approve, archive, recordPr, unblock } from './stages.mjs';
import { pendingProjects } from './config.mjs';
import { exportConfig } from './share.mjs';
import { formatBrief, inheritedWorkflow, previewWorkflow, resolveWorkflow, saveWorkflow, stageBrief, workflowOverride, workflowShape } from './workflow.mjs';
import { loadState } from './state.mjs';

export { boardPort };

// Runs the factory CLI for an intake, so the board and the terminal create a task the same way.
function intake(kind, ref) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(codeRoot(), 'bin', 'factory.mjs'), kind, ref], { timeout: 180_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').at(-1).replace(/^factory: /, '')));
      return resolve(stdout.trim());
    });
  });
}

// GitHub search allows 30 requests a minute, and "gh auth status" calls the network.
const CACHE_MS = 60_000;

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  res.end(body);
}

const MAX_BODY = 100_000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let over = false;
    // Text arrives whole: a character split across two packets is put together before it is read.
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      // Past the limit nothing more is kept; the rest of the request is read and dropped.
      if (over) return;
      raw += chunk;
      if (raw.length > MAX_BODY) {
        over = true;
        raw = '';
        reject(new Error('Request body is too large.'));
      }
    });
    req.on('end', () => {
      if (over) return undefined;
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return reject(new Error('Request body is not JSON.'));
      }
      // Every action reads named fields, so anything but an object is a malformed request.
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new Error('Request body must be a JSON object.'));
      return resolve(body);
    });
  });
}

/** Starts the board server and resolves with it once it listens. */
export function startServer(port = boardPort(), { pairing = true } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  // Set once the port is known; `pairing: false` is for tests that drive the server without a browser.
  let pair = null;
  let hosts = [];
  let checks = null;
  let issues = null;
  const peopleCache = new Map();
  const fresh = (entry) => entry && Date.now() - entry.at < CACHE_MS;
  // Requests for the same slow answer share one job instead of queueing one each.
  const inFlight = new Map();
  const shared = (key, start) => {
    if (!inFlight.has(key)) inFlight.set(key, start().finally(() => inFlight.delete(key)));
    return inFlight.get(key);
  };
  // A task id from a request; anything else is refused before it reaches a job.
  const issueId = (value) => { issueDir(String(value)); return String(value); };

  // Open event streams, told when task data changes so the board need not wait for its next poll.
  const streams = new Set();
  let built = null;
  let pendingNotice = null;
  const announce = () => {
    pendingNotice ||= setTimeout(() => {
      pendingNotice = null;
      for (const stream of streams) stream.write('event: change\ndata: {}\n\n');
    }, 1000);
  };
  fs.mkdirSync(issuesDir(), { recursive: true });
  let watcher = null;
  try {
    // Files the board itself writes, and logs still being written, are not news.
    watcher = fs.watch(issuesDir(), { recursive: true }, (event, file) => {
      if (!file || /tokens\.json|agent\.log|\.tmp$|\.lock$|\.running-/.test(String(file))) return;
      announce();
    });
    watcher.unref();
  } catch {
    // Without a watcher the board still refreshes by polling.
  }
  // Agent sessions this server started. A change in one is news for every open board.
  // Slow work runs on other threads: "local" for this machine, "net" for what waits on the network.
  const lanes = createLanes();
  const local = (job, args) => lanes.run('local', job, args);
  const net = (job, args) => lanes.run('net', job, args);
  const runner = createRunner({ onChange: () => { built = null; announce(); } });
  let agentsInfo = null;
  const beat = setInterval(() => { for (const stream of streams) stream.write(': keep-alive\n\n'); }, 25_000);
  beat.unref();

  const server = http.createServer(async (req, res) => {
    try {
      // Rejects requests that reach the port through another host name.
      if (!hosts.includes(req.headers.host)) return send(res, 403, 'text/plain', 'Forbidden host.');
      // Browsers label where a request comes from; another site may not load board data as a script.
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, 'text/plain', 'Cross-site requests are refused.');
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (pair) {
        // "factory board" proves it holds the key and gets a code to open the browser with.
        if (req.method === 'POST' && url.pathname === '/api/pair/start') {
          const code = pair.start(req.headers['x-factory-key']);
          return code ? send(res, 200, 'application/json', JSON.stringify({ code })) : send(res, 403, 'application/json', '{"error":"The pairing key does not match this board."}');
        }
        if (req.method === 'GET' && url.pathname === '/pair') {
          const cookie = pair.redeem(String(url.searchParams.get('code') || ''));
          if (!cookie) return send(res, 403, 'text/html; charset=utf-8', unpairedPage(true));
          res.writeHead(302, { Location: '/', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
          return res.end();
        }
        // Everything else belongs to a paired browser. The ping stays open: it only says which board answers.
        if (url.pathname !== '/api/ping' && !pair.paired(req)) {
          return req.method === 'GET' && (url.pathname === '/' || url.pathname === '/board.html') ? send(res, 200, 'text/html; charset=utf-8', unpairedPage()) : send(res, 401, 'application/json', '{"error":"This browser is not paired with the board. Run \\"factory board\\" in a terminal."}');
        }
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/board.html')) {
        const page = boardTemplate().replace('<!--factory-token-->', `<script>window.__factoryToken=${JSON.stringify(token)};</script>`);
        return send(res, 200, 'text/html; charset=utf-8', page);
      }
      if (req.method === 'GET' && url.pathname === '/board-data.js') {
        let script;
        try {
          // Several pages, or a burst of change notices, share one build.
          if (!built || Date.now() - built.at > 1000) {
            // Requests that arrive during a build wait for that build and share its result.
            const build = { at: Date.now(), pending: local('board') };
            built = build;
            build.script = await build.pending;
          }
          script = built.script ?? await built.pending;
        } catch (err) {
          // The page shows the reason instead of a silent "disconnected".
          script = `window.__factoryError(${JSON.stringify(String(err.message)).replace(/</g, '\\u003c')});\n`;
        }
        return send(res, 200, 'text/javascript; charset=utf-8', script);
      }
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        return send(res, 200, 'application/json', JSON.stringify(await local('diff', { id: issueId(url.searchParams.get('id')) })));
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.write('retry: 3000\n\n');
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/ping') {
        return send(res, 200, 'application/json', JSON.stringify({ root: factoryRoot(), pid: process.pid }));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/issues/') && url.pathname.endsWith('.log')) {
        const file = path.join(issuesDir(), decodeURIComponent(url.pathname.slice('/issues/'.length)));
        if (!within(file, issuesDir()) || !fs.existsSync(file) || !within(fs.realpathSync(file), fs.realpathSync(issuesDir()))) return send(res, 404, 'text/plain', 'Not found.');
        return send(res, 200, 'text/plain; charset=utf-8', fs.readFileSync(file));
      }
      if (req.method === 'GET' && url.pathname === '/api/setup') {
        if (!fresh(checks)) checks = await shared('setup', () => net('setup').then((value) => ({ at: Date.now(), value })));
        // Projects change on this machine at any moment; the tool checks are what is slow and kept.
        return send(res, 200, 'application/json', JSON.stringify({ ...checks.value, candidates: discoverProjects(), pending: Object.entries(pendingProjects()).map(([key, entry]) => ({ key, remote: entry.remote })), hooksInstalled: hooksInstalled() }));
      }
      if (req.method === 'GET' && url.pathname === '/api/github/issues') {
        const filter = issueFilter();
        const key = JSON.stringify(filter);
        if (url.searchParams.has('fresh') || !fresh(issues) || issues.key !== key) issues = await shared(`issues:${key}`, () => net('issues', { filter }).then((value) => ({ at: Date.now(), key, value })));
        return send(res, 200, 'application/json', JSON.stringify({ ...issues.value, issues: await local('withTasks', { issues: issues.value.issues }), loadedAt: new Date(issues.at).toISOString() }));
      }
      if (req.method === 'GET' && url.pathname === '/api/report') {
        return send(res, 200, 'application/json', JSON.stringify(await net('report', { day: url.searchParams.get('day') || 'today' })));
      }
      // Who can review or be assigned in a project's repository; asked once per ten minutes.
      if (req.method === 'GET' && url.pathname === '/api/people') {
        const { remote } = getRepo(String(url.searchParams.get('project')));
        const cached = peopleCache.get(remote);
        if (!cached || Date.now() - cached.at > 10 * CACHE_MS) peopleCache.set(remote, await shared(`people:${remote}`, () => net('people', { remote }).then((value) => ({ at: Date.now(), value }))));
        return send(res, 200, 'application/json', JSON.stringify(peopleCache.get(remote).value));
      }
      // The agent settings, the harness and its choices. Asking the harness for its version starts a program, so the answer is kept a minute.
      if (req.method === 'GET' && url.pathname === '/api/agents') {
        if (!fresh(agentsInfo)) agentsInfo = await shared('agents', () => net('agents').then((value) => ({ at: Date.now(), value })));
        return send(res, 200, 'application/json', JSON.stringify({ ...agentsInfo.value, running: runner.active(), queued: runner.queued() }));
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        return send(res, 200, 'application/json', `${JSON.stringify(exportConfig(), null, 2)}\n`);
      }
      if (req.method === 'GET' && url.pathname === '/api/workflow') {
        const scope = url.searchParams.get('scope') || 'global';
        const project = scope === 'global' ? null : scope;
        const found = project ? proposeForProject(project) : proposeGlobal();
        return send(res, 200, 'application/json', JSON.stringify({ scope, shape: workflowShape(resolveWorkflow(project)), inherited: inheritedWorkflow(scope), override: workflowOverride(scope), resolved: resolveWorkflow(project), user: userAssets(), models: modelChoices(), ...found }));
      }
      if (req.method === 'GET' && url.pathname === '/api/workflow/preview') {
        const scope = url.searchParams.get('scope') || 'global';
        const repo = scope === 'global' ? { key: null, dir: workspace() } : getRepo(scope);
        const state = { id: `${repo.key || 'example'}-0`, kind: url.searchParams.get('pipeline') === 'review' ? 'review' : 'issue', stage: String(url.searchParams.get('stage')), type: url.searchParams.get('type') || undefined, worktree: repo.dir };
        return send(res, 200, 'application/json', JSON.stringify({ text: formatBrief(stageBrief(state, repo, resolveWorkflow(repo.key))) }));
      }
      // Every POST changes local state, so each one needs the token the page was served with.
      if (req.method === 'POST' && req.headers['x-factory-token'] !== token) return send(res, 403, 'application/json', '{"error":"Reload the board and try again."}');
      // A change is on the board with the next load, not a second later when the shared build expires.
      if (req.method === 'POST') res.on('finish', () => { built = null; });
      // Sends the day's facts to the Claude CLI on this machine; nothing is stored.
      if (req.method === 'POST' && url.pathname === '/api/report/write') {
        const { day } = await readJson(req);
        return send(res, 200, 'application/json', JSON.stringify({ text: await writePlainReport(await net('report', { day: String(day) })) }));
      }
      if (req.method === 'POST' && url.pathname === '/api/agents/settings') {
        const settings = saveAgentSettings(await readJson(req));
        agentsInfo = null;
        built = null;
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, settings }));
      }
      // Starts the user's coding agent on a task, or stops the one this server started.
      if (req.method === 'POST' && url.pathname === '/api/agent/run') {
        const { id } = await readJson(req);
        const status = runner.start(String(id));
        built = null;
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, status }));
      }
      if (req.method === 'POST' && url.pathname === '/api/agent/stop') {
        const { id } = await readJson(req);
        if (!runner.stop(String(id))) throw new Error(`No agent started from this board runs on ${id}.`);
        built = null;
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/github/filter') {
        const filter = saveIssueFilter(await readJson(req));
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, filter }));
      }
      // Previews an unsaved draft; nothing is written.
      if (req.method === 'POST' && url.pathname === '/api/workflow/preview') {
        const { scope, workflow, pipeline, stage, type } = await readJson(req);
        const repo = scope === 'global' ? { key: null, dir: workspace() } : getRepo(String(scope));
        const state = { id: `${repo.key || 'example'}-0`, kind: pipeline === 'review' ? 'review' : 'issue', stage: String(stage), type: type || undefined, worktree: repo.dir };
        const draft = previewWorkflow(String(scope), workflow);
        // The stage may be gone from the draft; the shape still tells the page what exists.
        const text = draft.stages[state.stage] || state.kind === 'review' ? formatBrief(stageBrief(state, repo, draft)) : '';
        return send(res, 200, 'application/json', JSON.stringify({ text, shape: workflowShape(draft) }));
      }
      if (req.method === 'POST' && url.pathname === '/api/workflow') {
        const { scope, workflow } = await readJson(req);
        saveWorkflow(String(scope), workflow);
        await local('writeBoard');
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && (url.pathname === '/api/workflow/accept' || url.pathname === '/api/workflow/dismiss')) {
        const { project, ids } = await readJson(req);
        if (!Array.isArray(ids)) throw new Error('ids must be a list of proposal ids.');
        if (url.pathname.endsWith('accept')) acceptProposals(String(project), ids.map(String));
        else dismissProposals(String(project), ids);
        await local('writeBoard');
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/project/update') {
        const { key, ...patch } = await readJson(req);
        updateProject(String(key), patch);
        await local('writeBoard');
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/project/add') {
        const { key, dir, baseBranch, install, gates } = await readJson(req);
        // locateProject repeats the checks the page ran: a real repository root with a GitHub origin, not registered yet.
        addProject(String(key), locateProject(dir).dir, { base: baseBranch, install, gates });
        await local('writeBoard');
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      // Declares the relationships package.json files show, so the map has something to draw.
      if (req.method === 'POST' && url.pathname === '/api/graph/declare') {
        const result = withSettings(() => {
          const registry = loadRegistry();
          const found = declareDetectedLinks(registry);
          if (found.added.length) saveRegistry(registry);
          return found;
        });
        await local('writeBoard');
        return send(res, 200, 'application/json', JSON.stringify(result));
      }
      if (req.method === 'POST' && url.pathname === '/api/project/locate') {
        const { path: typed } = await readJson(req);
        return send(res, 200, 'application/json', JSON.stringify(locateProject(typed)));
      }
      if (req.method === 'POST' && url.pathname === '/api/project/remove') {
        const { key } = await readJson(req);
        removeProject(String(key));
        await local('writeBoard');
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/archive') {
        const { id, deleteBranch } = await readJson(req);
        await local('archive', { id: issueId(id), deleteBranch: deleteBranch === true });
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/task/start') {
        const { project, number, kind } = await readJson(req);
        if (!Object.hasOwn(loadRegistry().repos, String(project))) throw new Error(`Unknown project "${project}". Pick one of the registered projects.`);
        if (!Number.isInteger(number) || number < 1) throw new Error(`The issue or pull request number must be a whole number above 0, got ${JSON.stringify(number)}.`);
        if (!['new', 'review'].includes(kind)) throw new Error(`kind must be "new" or "review", got ${JSON.stringify(kind)}.`);
        const output = await intake(kind, `${project}#${number}`);
        // A review is its own task beside the issue with the same number.
        const taskId = kind === 'review' ? `${project}-pr-${number}` : `${project}-${number}`;
        // With auto-start on, the new task gets its agent at once; a failure to start does not undo the task.
        let agent = null;
        if (agentSettings().autoStart) {
          try { agent = runner.start(taskId); } catch (err) { agent = `not started: ${err.message}`; }
        }
        built = null;
        await local('writeBoard');
        return send(res, 200, 'application/json', JSON.stringify({ id: taskId, output, agent }));
      }
      // Pushes and opens the pull request, or posts the review, for the version the user approved.
      if (req.method === 'POST' && (url.pathname === '/api/pr/create' || url.pathname === '/api/review/post')) {
        const { id, title, draft, reviewers, assignees } = await readJson(req);
        const repo = getRepo(loadState(String(id)).repo);
        const link = url.pathname === '/api/pr/create' ? await createPullRequest(id, repo, { title, draft: draft === true, reviewers, assignees }) : await postReview(id, repo);
        await local('writeBoard');
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, url: link }));
      }
      // Records a pull request the user opened by hand, like "factory pr" does.
      if (req.method === 'POST' && url.pathname === '/api/pr') {
        const { id, url: prUrl } = await readJson(req);
        await local('recordPr', { id: issueId(id), url: String(prUrl ?? '').trim() });
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/unblock') {
        const { id, note } = await readJson(req);
        await local('unblock', { id: issueId(id), note });
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      // Posts the drafted questions on the issue, as the user. The task stays blocked until it is unblocked.
      if (req.method === 'POST' && url.pathname === '/api/questions/post') {
        const { id, sha } = await readJson(req);
        const sent = await net('postQuestions', { id: issueId(id), sha });
        if (sent.conflict) return send(res, 409, 'application/json', JSON.stringify({ error: sent.conflict }));
        const posted = await local('questionsPosted', { id: issueId(id), url: sent.url });
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, url: posted.url }));
      }
      // Asks GitHub about the task's open pull request. This happens only when the user asks.
      if (req.method === 'POST' && url.pathname === '/api/followup/check') {
        const { id } = await readJson(req);
        await net('prFeedback', { id: issueId(id) });
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      // Sends the task back to the agent with the user's words about the pull request.
      if (req.method === 'POST' && url.pathname === '/api/followup/send') {
        const { id, note } = await readJson(req);
        await local('sendFeedback', { id: issueId(id), text: note });
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      // Sending back and approving cover the version the page showed; a version that changed since is refused.
      if (req.method === 'POST' && (url.pathname === '/api/reject' || url.pathname === '/api/approve')) {
        const { id, key, reason, lesson } = await readJson(req);
        const done = await local(url.pathname === '/api/approve' ? 'approve' : 'reject', { id: issueId(id), key, reason, lesson });
        if (done.conflict) return send(res, 409, 'application/json', JSON.stringify({ error: done.conflict }));
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      return send(res, 404, 'text/plain', 'Not found.');
    } catch (err) {
      return send(res, 400, 'application/json', JSON.stringify({ error: err.message }));
    }
  });

  // Lets the process that owns the server end the sessions before it exits.
  server.stopAgents = () => { runner.close(); lanes.close(); };
  server.on('close', () => {
    runner.close();
    lanes.close();
    watcher?.close();
    clearInterval(beat);
    clearTimeout(pendingNotice);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const bound = server.address().port;
      hosts = [`127.0.0.1:${bound}`, `localhost:${bound}`];
      if (pairing) pair = createPairing(bound);
      resolve(server);
    });
  });
}
