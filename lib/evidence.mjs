// Records command runs as hash-chained evidence bound to a commit SHA.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withTask } from './lock.mjs';
import { evidenceDir } from './paths.mjs';
import { head, isDirty } from './state.mjs';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Hashes the record without its own hash field.
function hashRecord(record) {
  const { hash, ...rest } = record;
  return sha256(JSON.stringify(rest));
}

export function listEvidence(id) {
  const dir = evidenceDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// The number and the chain link come from the records on disk, so two runs that end together take turns.
function append(id, fields, logText) {
  return withTask(id, () => appendLocked(id, fields, logText));
}

function appendLocked(id, fields, logText) {
  const dir = evidenceDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const records = listEvidence(id);
  const seq = records.length + 1;
  const base = `${String(seq).padStart(3, '0')}-${fields.name.replace(/[^a-z0-9.-]+/gi, '_')}`;
  const record = { seq, ...fields, prev: records.at(-1)?.hash || null };
  if (logText !== undefined) {
    record.log = `${base}.log`;
    record.logSha256 = sha256(logText);
    fs.writeFileSync(path.join(dir, record.log), logText);
  }
  record.hash = hashRecord(record);
  fs.writeFileSync(path.join(dir, `${base}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Runs cmd in cwd, stores its output as a log and appends an evidence record.
 * `expect` is "pass" or "fail"; `ok` is true when the exit code matches it.
 */
export function runRecorded(state, { name, kind = 'gate', cmd, cwd, actor = 'implementer', expect = 'pass', sha, extra = {}, timeoutMinutes = 30, match = null }) {
  const dir = evidenceDir(state.id);
  fs.mkdirSync(dir, { recursive: true });
  const dirty = isDirty(state);
  const commit = sha || head(state);
  const tmpLog = path.join(dir, `.running-${process.pid}.log`);
  const fd = fs.openSync(tmpLog, 'w');
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const r = spawnSync('sh', ['-c', cmd], {
    cwd,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI || '1' },
    timeout: timeoutMinutes > 0 ? timeoutMinutes * 60_000 : undefined,
  });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  if (timedOut) fs.writeSync(fd, `\n[Codeignite] Stopped after ${timeoutMinutes} minute(s) without finishing.\n`);
  fs.closeSync(fd);
  const exitCode = r.status ?? 1;
  const logText = fs.readFileSync(tmpLog, 'utf8');
  // A timeout proves nothing either way, and an expected failure may be required to show a given text.
  const exitOk = expect === 'fail' ? exitCode !== 0 : exitCode === 0;
  const matched = match ? logText.includes(match) : true;
  const record = append(
    state.id,
    {
      name,
      kind,
      actor,
      cmd,
      cwd,
      sha: commit,
      dirty,
      expect,
      exitCode,
      ok: exitOk && matched && !timedOut,
      startedAt,
      durationMs: Date.now() - t0,
      ...(timedOut ? { timedOut: true } : {}),
      ...(match ? { match, matched } : {}),
      ...extra,
    },
    logText,
  );
  fs.rmSync(tmpLog);
  return record;
}

/** Appends a record that no command produced; the board flags it as manual. */
export function addManual(state, { name, text, actor = 'implementer' }) {
  return append(state.id, {
    name,
    kind: 'manual',
    actor,
    text,
    sha: head(state),
    dirty: isDirty(state),
    ok: true,
    startedAt: new Date().toISOString(),
  });
}

/** Appends the verifier verdict with the hash of the PR body it judged. */
export function addVerdict(state, { verdict, report, prBodySha256 }) {
  return append(
    state.id,
    {
      name: 'verdict',
      kind: 'verdict',
      actor: 'verifier',
      verdict,
      prBodySha256,
      sha: head(state),
      dirty: isDirty(state),
      ok: verdict === 'pass',
      startedAt: new Date().toISOString(),
    },
    report,
  );
}

/** Returns the newest record matching name and the optional predicate. */
export function latest(records, name, pred = () => true) {
  return records.findLast((r) => r.name === name && pred(r)) || null;
}

/** Checks the hash chain and every log hash; returns the problems found. */
export function verifyChain(id) {
  const problems = [];
  let prev = null;
  for (const r of listEvidence(id)) {
    if (r.prev !== prev) problems.push(`Record ${r.seq} (${r.name}) does not follow record ${r.seq - 1}.`);
    if (hashRecord(r) !== r.hash) problems.push(`Record ${r.seq} (${r.name}) was edited after it was written.`);
    if (r.log) {
      const file = path.join(evidenceDir(id), r.log);
      if (!fs.existsSync(file)) problems.push(`Log ${r.log} is missing.`);
      else if (sha256(fs.readFileSync(file, 'utf8')) !== r.logSha256) problems.push(`Log ${r.log} was edited after the run.`);
    }
    prev = r.hash;
  }
  return problems;
}

export const fileSha256 = (file) => sha256(fs.readFileSync(file, 'utf8'));
