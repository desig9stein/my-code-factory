// Records command runs as hash-chained evidence bound to a commit SHA.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withTask } from './lock.mjs';
import { fileURLToPath } from 'node:url';
import { boardKey } from './pairing.mjs';
import { evidenceDir, issueDir } from './paths.mjs';
import { head, isDirty } from './state.mjs';
import { taskEnv } from './taskenv.mjs';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Hashes the record without its own hash field.
function hashRecord(record) {
  const { hash, ...rest } = record;
  return sha256(JSON.stringify(rest));
}

const RUNNER = fileURLToPath(new URL('./runcmd.mjs', import.meta.url));
const numberOf = (file) => Number(/^\d+/.exec(file)?.[0] ?? 0);

/**
 * Returns the task's evidence records in the order they were written. A record file that cannot be read stands in
 * the list as a record marked `damaged`, so one bad file is reported as tampering and does not stop every command.
 */
export function listEvidence(id) {
  const dir = evidenceDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    // By number: as text, record 1000 would sort before record 999.
    .sort((a, b) => numberOf(a) - numberOf(b) || a.localeCompare(b))
    .map((f) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (record && typeof record === 'object' && !Array.isArray(record)) return record;
      } catch {
        // Reported below.
      }
      return { seq: numberOf(f), name: f, kind: 'damaged', damaged: true, ok: false, hash: null, prev: null, startedAt: '' };
    });
}

// The count and the last hash of the chain, sealed with a key that lives outside the task folder. Without it the
// newest record could be deleted, or a record rewritten with a hash worked out again, and the chain would still link.
const headPath = (id) => path.join(evidenceDir(id), '.head');
const seal = (id, count, last) => crypto.createHmac('sha256', boardKey()).update(`evidence:${id}:${count}:${last}`).digest('hex');
function writeHead(id, count, last) {
  fs.mkdirSync(evidenceDir(id), { recursive: true });
  fs.writeFileSync(headPath(id), `${JSON.stringify({ count, last, seal: seal(id, count, last) })}\n`);
}
/** Seals a text with the key that lives outside the task folder: only Codeignite's own code can make the same seal. */
export const sealOf = (text) => crypto.createHmac('sha256', boardKey()).update(String(text)).digest('hex');
/** Starts the sealed count of a new task's evidence at nothing. The task's state then carries `sealed: true`. */
export const sealEvidence = (id) => writeHead(id, 0, null);

// The number and the chain link come from the records on disk, so two runs that end together take turns.
function append(id, fields, logText) {
  return withTask(id, () => appendLocked(id, fields, logText));
}

function appendLocked(id, fields, logText) {
  const dir = evidenceDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const records = listEvidence(id);
  const seq = records.length + 1;
  const base = `${String(seq).padStart(3, '0')}-${String(fields.name).replace(/[^a-z0-9.-]+/gi, '_')}`;
  const record = { seq, ...fields, prev: records.at(-1)?.hash || null };
  if (logText !== undefined) {
    record.log = `${base}.log`;
    record.logSha256 = sha256(logText);
    fs.writeFileSync(path.join(dir, record.log), logText);
  }
  record.hash = hashRecord(record);
  fs.writeFileSync(path.join(dir, `${base}.json`), `${JSON.stringify(record, null, 2)}\n`);
  writeHead(id, seq, record.hash);
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
  const limit = timeoutMinutes > 0 ? Math.round(timeoutMinutes * 60_000) : 0;
  const marker = `${tmpLog}.timeout`;
  // The command runs under lib/runcmd.mjs, which ends the whole tree at the limit; the second limit here is for a runner that hangs.
  const r = spawnSync(process.execPath, [RUNNER, String(limit), marker, cmd], {
    cwd,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...taskEnv(state), FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI || '1' },
    timeout: limit ? limit + 15_000 : undefined,
  });
  const timedOut = fs.existsSync(marker) || r.error?.code === 'ETIMEDOUT';
  fs.rmSync(marker, { force: true });
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

/** Checks the hash chain, every log hash and the sealed count; returns the problems found. */
export function verifyChain(id) {
  const problems = [];
  let prev = null;
  const records = listEvidence(id);
  for (const r of records) {
    if (r.damaged) {
      problems.push(`Record file ${r.name} cannot be read.`);
      prev = null;
      continue;
    }
    if (r.prev !== prev) problems.push(`Record ${r.seq} (${r.name}) does not follow record ${r.seq - 1}.`);
    if (hashRecord(r) !== r.hash) problems.push(`Record ${r.seq} (${r.name}) was edited after it was written.`);
    if (r.log) {
      const file = path.join(evidenceDir(id), r.log);
      if (!fs.existsSync(file)) problems.push(`Log ${r.log} is missing.`);
      else if (sha256(fs.readFileSync(file, 'utf8')) !== r.logSha256) problems.push(`Log ${r.log} was edited after the run.`);
    }
    prev = r.hash;
  }
  // A task made before the seal existed has none to compare with.
  let sealed = false;
  try {
    sealed = JSON.parse(fs.readFileSync(path.join(issueDir(id), 'state.json'), 'utf8'))?.sealed === true;
  } catch {
    // An unreadable state is reported where the state is loaded.
  }
  if (sealed) {
    let head = null;
    try {
      head = JSON.parse(fs.readFileSync(headPath(id), 'utf8'));
    } catch {
      // Missing or damaged: reported next.
    }
    const last = records.at(-1)?.hash ?? null;
    if (!head || head.seal !== seal(id, head.count, head.last)) problems.push('The sealed count of the evidence is missing or was edited.');
    else if (head.count !== records.length) problems.push(`${head.count} evidence record(s) were written and ${records.length} ${records.length === 1 ? 'is' : 'are'} there: ${head.count > records.length ? 'the newest were removed' : 'records were added by hand'}.`);
    else if (head.last !== last) problems.push('The newest evidence record is not the one that was written last.');
  }
  return problems;
}

export const fileSha256 = (file) => sha256(fs.readFileSync(file, 'utf8'));
