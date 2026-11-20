// Serves the board on 127.0.0.1 and runs its approve, archive, project and issue-filter actions.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mergeBase } from './checks.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { boardScript, boardTemplate, writeBoard } from './board.mjs';
import { acceptProposals, dismissProposals, proposeForProject, proposeGlobal, userAssets } from './assets.mjs';
import { issueFilter, saveIssueFilter, searchIssues, withTasks } from './github.mjs';
import { hooksInstalled } from './hooks.mjs';
import { factoryRoot, issuesDir, within, workspace } from './paths.mjs';
import { boardPort } from './port.mjs';
import { modelChoices } from './providers.mjs';
import { getRepo } from './registry.mjs';
import { dayFacts, writePlainReport } from './report.mjs';
import { addProject, discoverProjects, locateProject, preflight, removeProject, updateProject } from './setup.mjs';
import { approvalKey, approve, archive, sendBack } from './stages.mjs';
import { exportConfig } from './share.mjs';
import { sync } from './state.mjs';
import { formatBrief, inheritedWorkflow, previewWorkflow, resolveWorkflow, saveWorkflow, stageBrief, workflowOverride, workflowShape } from './workflow.mjs';
import { loadState } from './state.mjs';

export { boardPort };

// GitHub search allows 30 requests a minute, and "gh auth status" calls the network.
const CACHE_MS = 60_000;

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) reject(new Error('Request body is too large.'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new Error('Request body is not JSON.'));
      }
    });
  });
}

/** Starts the board server and resolves with it once it listens. */
export function startServer(port = boardPort()) {
  const token = crypto.randomBytes(16).toString('hex');
  let hosts = [];
  let checks = null;
  let issues = null;
  const fresh = (entry) => entry && Date.now() - entry.at < CACHE_MS;

  const server = http.createServer(async (req, res) => {
    try {
      // Rejects requests that reach the port through another host name.
      if (!hosts.includes(req.headers.host)) return send(res, 403, 'text/plain', 'Forbidden host.');
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/board.html')) {
        const page = boardTemplate().replace('<!--factory-token-->', `<script>window.__factoryToken=${JSON.stringify(token)};</script>`);
        return send(res, 200, 'text/html; charset=utf-8', page);
      }
      if (req.method === 'GET' && url.pathname === '/board-data.js') {
        return send(res, 200, 'text/javascript; charset=utf-8', boardScript());
      }
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        const state = loadState(url.searchParams.get('id'));
        const result = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', `${mergeBase(state)}..HEAD`], { cwd: state.worktree, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
        if (result.status !== 0) throw new Error(result.error?.code === 'ENOBUFS' ? 'Diff exceeds 2 MB. Inspect it in your Git client.' : 'Could not read the committed diff. Check that the worktree exists.');
        return send(res, 200, 'application/json', JSON.stringify({ diff: result.stdout }));
      }
      if (req.method === 'GET' && url.pathname === '/api/ping') {
        return send(res, 200, 'application/json', JSON.stringify({ root: factoryRoot() }));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/issues/') && url.pathname.endsWith('.log')) {
        const file = path.join(issuesDir(), decodeURIComponent(url.pathname.slice('/issues/'.length)));
        if (!within(file, issuesDir()) || !fs.existsSync(file) || !within(fs.realpathSync(file), fs.realpathSync(issuesDir()))) return send(res, 404, 'text/plain', 'Not found.');
        return send(res, 200, 'text/plain; charset=utf-8', fs.readFileSync(file));
      }
      if (req.method === 'GET' && url.pathname === '/api/setup') {
        if (!fresh(checks)) checks = { at: Date.now(), value: preflight() };
        return send(res, 200, 'application/json', JSON.stringify({ root: factoryRoot(), workspace: workspace(), checks: checks.value, candidates: discoverProjects(), hooksInstalled: hooksInstalled() }));
      }
      if (req.method === 'GET' && url.pathname === '/api/github/issues') {
        const filter = issueFilter();
        const key = JSON.stringify(filter);
        if (url.searchParams.has('fresh') || !fresh(issues) || issues.key !== key) issues = { at: Date.now(), key, value: searchIssues(filter) };
        return send(res, 200, 'application/json', JSON.stringify({ ...issues.value, issues: withTasks(issues.value.issues), loadedAt: new Date(issues.at).toISOString() }));
      }
      if (req.method === 'GET' && url.pathname === '/api/report') {
        return send(res, 200, 'application/json', JSON.stringify(dayFacts(url.searchParams.get('day') || 'today')));
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
      // Sends the day's facts to the Claude CLI on this machine; nothing is stored.
      if (req.method === 'POST' && url.pathname === '/api/report/write') {
        const { day } = await readJson(req);
        return send(res, 200, 'application/json', JSON.stringify({ text: await writePlainReport(dayFacts(String(day))) }));
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
        writeBoard();
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && (url.pathname === '/api/workflow/accept' || url.pathname === '/api/workflow/dismiss')) {
        const { project, ids } = await readJson(req);
        if (!Array.isArray(ids)) throw new Error('ids must be a list of proposal ids.');
        if (url.pathname.endsWith('accept')) acceptProposals(String(project), ids.map(String));
        else dismissProposals(String(project), ids);
        writeBoard();
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/project/update') {
        const { key, ...patch } = await readJson(req);
        updateProject(String(key), patch);
        writeBoard();
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/project/add') {
        const { key, dir, baseBranch, install, gates } = await readJson(req);
        // locateProject repeats the checks the page ran: a real repository root with a GitHub origin, not registered yet.
        addProject(String(key), locateProject(dir).dir, { base: baseBranch, install, gates });
        writeBoard();
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/project/locate') {
        const { path: typed } = await readJson(req);
        return send(res, 200, 'application/json', JSON.stringify(locateProject(typed)));
      }
      if (req.method === 'POST' && url.pathname === '/api/project/remove') {
        const { key } = await readJson(req);
        removeProject(String(key));
        writeBoard();
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/archive') {
        const { id, deleteBranch } = await readJson(req);
        const state = loadState(String(id));
        archive(state, getRepo(state.repo), { deleteBranch: deleteBranch === true });
        writeBoard();
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/reject') {
        const { id, key, reason, lesson } = await readJson(req);
        const state = sync(loadState(String(id)));
        if (key !== approvalKey(state)) return send(res, 409, 'application/json', '{"error":"This changed since the board showed it. Read it again, then decide."}');
        sendBack(state, getRepo(state.repo), { reason, lesson });
        writeBoard();
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/approve') {
        const { id, key } = await readJson(req);
        const state = sync(loadState(String(id)));
        // Refuses when the commit, the draft or the PR body changed after the page showed them.
        if (key !== approvalKey(state)) {
          return send(res, 409, 'application/json', '{"error":"This changed since the board showed it. Read it again, then approve."}');
        }
        approve(state);
        writeBoard();
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      return send(res, 404, 'text/plain', 'Not found.');
    } catch (err) {
      return send(res, 400, 'application/json', JSON.stringify({ error: err.message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const bound = server.address().port;
      hosts = [`127.0.0.1:${bound}`, `localhost:${bound}`];
      resolve(server);
    });
  });
}
