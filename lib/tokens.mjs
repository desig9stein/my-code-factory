// Sums the Claude Code token usage of the sessions that worked on an issue.
import fs from 'node:fs';
import path from 'node:path';
import { activityUseIds } from './activity.mjs';
import { issueDir, namesId } from './paths.mjs';
import { withTask } from './lock.mjs';
import { writeJson } from './store.mjs';

const sessionsPath = (id) => path.join(issueDir(id), 'sessions.json');
const cachePath = (id) => path.join(issueDir(id), 'tokens.json');
const ZERO = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, messages: 0 };
const TTL_MS = 60_000;

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/** Records that a session transcript worked on the issue. */
export function linkSession(id, transcript) {
  if (!transcript || !fs.existsSync(issueDir(id))) return;
  if (readJson(sessionsPath(id), []).some((s) => s.transcript === transcript)) return;
  // The hook calls this on every tool call; a task that stays busy is linked by the next call.
  withTask(id, () => {
    const sessions = readJson(sessionsPath(id), []);
    if (sessions.some((s) => s.transcript === transcript)) return;
    sessions.push({ transcript, linkedAt: new Date().toISOString() });
    writeJson(sessionsPath(id), sessions);
  }, { wait: 2000 });
}

/** Returns when a linked session last wrote to its transcript, as an ISO time, or null. */
export function lastActivity(id, worktree = '') {
  let newest = 0;
  // Claude Code names a session's folder after the directory it started in, with every other character as "-".
  const home = worktree ? `/${worktree.replace(/[^a-zA-Z0-9]/g, '-')}/` : null;
  for (const session of readJson(sessionsPath(id), [])) {
    // A session started elsewhere that only named the task is not work on it.
    if (home && !String(session.transcript).includes(home)) continue;
    for (const file of transcriptFiles(session.transcript)) newest = Math.max(newest, fs.statSync(file).mtimeMs);
  }
  return newest ? new Date(newest).toISOString() : null;
}

// Lists a session transcript and the transcripts of its subagents.
function transcriptFiles(transcript) {
  const files = fs.existsSync(transcript) ? [transcript] : [];
  const sub = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  if (fs.existsSync(sub)) {
    for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f));
  }
  return files;
}

/**
 * Sums usage per API message inside the time window; a message spans several lines with one id.
 * In a session transcript only the messages whose tool calls name the issue count.
 * A subagent transcript counts in full when its prompt names the issue, and not at all otherwise.
 */
function sumFile(file, from, to, id, isSubagent, uses = new Set()) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (isSubagent && !lines.slice(0, 5).some((l) => namesId(l, id))) return { ...ZERO };
  const byMessage = new Map();
  const acted = new Set();
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = row.message?.usage;
    if (row.type !== 'assistant' || !usage || !row.timestamp) continue;
    if (row.timestamp < from || (to && row.timestamp > to)) continue;
    const key = row.message.id || row.uuid;
    byMessage.set(key, usage);
    const calls = (row.message.content || []).filter((c) => c.type === 'tool_use');
    // A call counts when it names the task, or when the hooks recorded it as running for the task.
    if (isSubagent || namesId(JSON.stringify(calls), id) || calls.some((c) => uses.has(c.id))) acted.add(key);
  }
  const sum = { ...ZERO };
  for (const [key, u] of byMessage) {
    if (!acted.has(key)) continue;
    sum.input += u.input_tokens || 0;
    sum.cacheWrite += u.cache_creation_input_tokens || 0;
    sum.cacheRead += u.cache_read_input_tokens || 0;
    sum.output += u.output_tokens || 0;
    sum.messages += 1;
  }
  return sum;
}

/**
 * Returns the token totals of an issue from its creation to its archive, or to now.
 * Counts the model calls that acted on the issue in the linked sessions, and its subagents.
 */
export function issueTokens(state, { force = false } = {}) {
  const sessions = readJson(sessionsPath(state.id), []);
  const to = state.history.find((h) => h.stage === 'archived')?.at || null;
  const cache = readJson(cachePath(state.id), { files: {} });
  const uses = activityUseIds(state.id);
  const signature = JSON.stringify([sessions, uses.size]);
  if (!force && cache.version === 3 && cache.signature === signature && cache.to === to && Date.now() - new Date(cache.computedAt).getTime() < TTL_MS) return cache.total;
  const total = { ...ZERO, sessions: sessions.length, bySession: [], missingFiles: 0, availableFiles: 0 };
  const files = {};
  const counted = new Set();
  const finish = (usage) => {
    usage.fresh = usage.input + usage.cacheWrite + usage.output;
    usage.total = usage.fresh + usage.cacheRead;
    usage.availability = !usage.messages ? 'unavailable' : usage.missingFiles ? 'partial' : 'available';
    return usage;
  };
  for (const [index, session] of sessions.entries()) {
    const part = { ...ZERO, id: `session-${index + 1}`, label: `Session ${index + 1}`, linkedAt: session.linkedAt, missingFiles: 0, availableFiles: 0 };
    if (!fs.existsSync(session.transcript)) part.missingFiles++;
    for (const file of transcriptFiles(session.transcript)) {
      if (counted.has(file)) continue;
      counted.add(file);
      try {
        const stat = fs.statSync(file);
        const key = `v3:${stat.mtimeMs}:${stat.size}:${to}:${uses.size}`;
        const sum = cache.files?.[file]?.key === key ? cache.files[file].sum : sumFile(file, state.createdAt, to, state.id, file !== session.transcript, uses);
        files[file] = { key, sum };
        part.availableFiles++;
        for (const k of Object.keys(ZERO)) part[k] += sum[k];
      } catch { part.missingFiles++; }
    }
    finish(part);
    total.bySession.push(part);
    for (const k of [...Object.keys(ZERO), 'missingFiles', 'availableFiles']) total[k] += part[k];
  }
  finish(total);
  total.computedAt = new Date().toISOString();
  total.source = 'claude-code';
  total.attribution = 'Tool calls naming this task or recorded by the hooks as running in its worktree, plus matching subagent transcripts. Unattributed messages are excluded.';
  if (fs.existsSync(issueDir(state.id))) fs.writeFileSync(cachePath(state.id), JSON.stringify({ version: 3, computedAt: total.computedAt, signature, to, total, files }));
  return total;
}

/** Formats a token count as 950, 12.4k or 3.2M. */
export function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
