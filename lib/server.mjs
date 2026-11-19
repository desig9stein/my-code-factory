// Serves the board on 127.0.0.1 and runs the archive action for it.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mergeBase } from './checks.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { boardScript, boardTemplate, writeBoard } from './board.mjs';
import { factoryRoot, issuesDir, within } from './paths.mjs';
import { boardPort } from './port.mjs';
import { getRepo } from './registry.mjs';
import { approvalKey, approve, archive } from './stages.mjs';
import { sync } from './state.mjs';
import { loadState } from './state.mjs';

export { boardPort };

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) reject(new Error('Request body is too large.'));
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

  // Open event streams, told when task data changes so the board need not wait for its next poll.
  const streams = new Set();
  let pendingNotice = null;
  const announce = () => {
    pendingNotice ||= setTimeout(() => {
      pendingNotice = null;
      for (const stream of streams) stream.write('event: change\ndata: {}\n\n');
    }, 400);
  };
  fs.mkdirSync(issuesDir(), { recursive: true });
  let watcher = null;
  try {
    // Files the board itself writes, and logs still being written, are not news.
    watcher = fs.watch(issuesDir(), { recursive: true }, (event, file) => {
      if (!file || /tokens\.json|\.tmp$|\.running-/.test(String(file))) return;
      announce();
    });
    watcher.unref();
  } catch {
    // Without a watcher the board still refreshes by polling.
  }
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
      if (req.method === 'POST' && url.pathname === '/api/archive') {
        if (req.headers['x-factory-token'] !== token) return send(res, 403, 'application/json', '{"error":"Reload the board and try again."}');
        const { id, deleteBranch } = await readJson(req);
        const state = loadState(String(id));
        archive(state, getRepo(state.repo), { deleteBranch: deleteBranch === true });
        writeBoard();
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && url.pathname === '/api/approve') {
        if (req.headers['x-factory-token'] !== token) return send(res, 403, 'application/json', '{"error":"Reload the board and try again."}');
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

  server.on('close', () => {
    watcher?.close();
    clearInterval(beat);
    clearTimeout(pendingNotice);
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
