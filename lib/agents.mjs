// Runs a coding agent on a task without a terminal: one fresh session per stage, until the task needs the user.
// The session is the user's own harness with their own login; this file decides when to start one and when to stop.
import { settingUp } from './tasksetup.mjs';
import { ensurePort } from './taskenv.mjs';
import { taskEnv } from './taskenv.mjs';
import { keyPath } from './pairing.mjs';
import { withLock, withSettings, withTask } from './lock.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig, writeConfig } from './config.mjs';
import { harness, harnesses } from './harnesses.mjs';
import { codeRoot, factoryRoot, issueDir } from './paths.mjs';
import { getRepo } from './registry.mjs';
import { advance } from './stages.mjs';
import { loadState, stagesOf, sync } from './state.mjs';
import { writeJson } from './store.mjs';
import { linkSession } from './tokens.mjs';
import { resolveWorkflow } from './workflow.mjs';

const DEFAULTS = { maxConcurrent: 2, autoStart: false, maxSessions: 12, sessionMinutes: 60, usageCap: 80, dailyBudget: 0 };
// usageCap is the share of the plan's usage limit, in percent, at which agents pause; 0 switches the brake off.
// dailyBudget is a cap in whole dollars on the cost Claude Code estimates for the day's sessions; 0 is off.
const LIMITS = { maxConcurrent: [1, 8], maxSessions: [1, 40], sessionMinutes: [1, 480], usageCap: [0, 100], dailyBudget: [0, 1000] };
// A usage figure older than this is asked for again before a run starts.
const USAGE_FRESH_MS = 30 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
// Past the share by this many points a running session is interrupted; below it the session may finish its step.
const HARD_STOP_POINTS = 10;
const WINDOW_NAMES = { five_hour: '5-hour', seven_day: 'weekly' };
// Stages where the user acts, or nothing is left to do.
const HUMAN_STAGES = ['ready', 'approved', 'pr-opened', 'posted'];
// Sessions in a row that may end without the task moving, before the run stops and says so.
const MAX_IDLE = 2;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_SAID = 2000;
const KILL_AFTER_MS = 8000;
// A running record is rewritten this often; one that has not been for three beats belongs to a process that is gone.
const BEAT_MS = 20_000;
const MAX_ALLOW = 20;
// One line of a session's output is an event of a few kilobytes. A longer one is dropped, not kept in memory.
const MAX_LINE = 8 * 1024 * 1024;
// A session that has reported its result and does not leave is ended after this long.
const LEAVE_AFTER_MS = 30_000;
// After a session's own process has gone, what it left holding its output gets this long before it is ended.
const DRAIN_MS = 1500;
const MAX_PREFIX = 200;
// Git commands a scoped session may run. Push is refused by name, and the guard hook refuses it before approval.
const GIT_ALLOWED = ['status', 'diff', 'log', 'show', 'add', 'commit', 'restore', 'stash', 'rev-parse', 'branch', 'merge-base', 'ls-files', 'blame', 'mv', 'rm'].map((word) => `git ${word}`);
// Read-only Git commands are also allowed in the form agents often write them: "git -C <worktree> diff".
const GIT_READS = ['status', 'diff', 'log', 'show', 'rev-parse', 'merge-base', 'ls-files', 'blame'];
// Harmless helpers agents append to a command, such as: codeignite run ...; echo "EXIT=$?"
const HELPERS = ['echo', 'pwd', 'true'];
const DENIED = ['git push', 'gh pr create', 'gh pr merge', 'gh pr comment', 'gh pr review', 'gh issue comment'];

const REASONS = {
  'your-turn': 'The task reached a step that is yours.',
  blocked: 'The task is blocked and waits for you.',
  stalled: `The agent ended ${MAX_IDLE} sessions in a row without finishing the step.`,
  error: 'The agent session failed.',
  stopped: 'You stopped the agent.',
  limit: 'The run used every session it may start.',
  timeout: 'A session ran longer than the time limit and was ended.',
  usage: 'Agents are paused to keep the share of your plan limit you set aside.',
  budget: 'Agents are paused at the cost you allow per day.',
  archived: 'The task was archived.',
  interrupted: 'The board stopped while the agent was running.',
  missing: 'The coding agent is not installed on this machine.',
};

const runPath = (id) => path.join(issueDir(id), 'agent-run.json');
const logPath = (id) => path.join(issueDir(id), 'agent.log');
const cliText = () => `node '${path.join(codeRoot(), 'bin', 'codeignite.mjs')}'`;

const alive = (pid) => {
  try {
    return Number.isInteger(pid) && process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// ----- settings -----

/** Returns the machine's agent settings with the defaults applied. Unknown stored values fall back to the default. */
export function agentSettings() {
  const stored = readConfig().agents || {};
  const tool = harnesses().find((item) => item.id === stored.harness) || harnesses()[0];
  const pick = (list, value) => (list.some((item) => item.id === value) ? value : list[0].id);
  const within = (name) => (Number.isInteger(stored[name]) && stored[name] >= LIMITS[name][0] && stored[name] <= LIMITS[name][1] ? stored[name] : DEFAULTS[name]);
  return {
    harness: tool.id,
    permission: pick(tool.permissionModes, stored.permission),
    account: pick(tool.accounts, stored.account),
    maxConcurrent: within('maxConcurrent'),
    maxSessions: within('maxSessions'),
    sessionMinutes: within('sessionMinutes'),
    usageCap: within('usageCap'),
    dailyBudget: within('dailyBudget'),
    autoStart: stored.autoStart === true,
  };
}

/** Checks and saves the agent settings; only the given fields change. Returns the settings in force. */
export const saveAgentSettings = (patch = {}) => withSettings(() => saveAgentSettingsNow(patch));

function saveAgentSettingsNow(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('The agent settings to save must be a list of settings and their values.');
  const current = agentSettings();
  const next = { ...current };
  const unknown = Object.keys(patch).find((field) => !Object.hasOwn(current, field));
  if (unknown) throw new Error(`"${unknown}" is not an agent setting. Settings: ${Object.keys(current).join(', ')}.`);
  if (patch.harness !== undefined) next.harness = harness(String(patch.harness)).id;
  const tool = harness(next.harness);
  const choice = (list, value, what) => {
    if (!list.some((item) => item.id === value)) throw new Error(`${what} must be one of ${list.map((item) => item.id).join(', ')}, got ${JSON.stringify(value)}.`);
    return value;
  };
  if (patch.permission !== undefined) next.permission = choice(tool.permissionModes, patch.permission, 'permission');
  if (patch.account !== undefined) next.account = choice(tool.accounts, patch.account, 'account');
  for (const name of Object.keys(LIMITS)) {
    if (patch[name] === undefined) continue;
    const [low, high] = LIMITS[name];
    if (!Number.isInteger(patch[name]) || patch[name] < low || patch[name] > high) throw new Error(`${name} must be a whole number from ${low} to ${high}, got ${JSON.stringify(patch[name])}.`);
    next[name] = patch[name];
  }
  if (patch.autoStart !== undefined) {
    if (typeof patch.autoStart !== 'boolean') throw new Error('autoStart must be true or false.');
    next.autoStart = patch.autoStart;
  }
  writeConfig({ agents: next });
  return next;
}

/**
 * Checks a project's own agent settings: { permission, allow }. An empty permission means "use the machine's".
 * `allow` lists command prefixes a scoped session may also run, such as "npm test".
 */
export function checkProjectAgent(input, tool = harness(agentSettings().harness)) {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('The agent settings of a project must be an object with "permission" and "allow".');
  const unknown = Object.keys(input).find((field) => !['permission', 'allow'].includes(field));
  if (unknown) throw new Error(`"${unknown}" is not an agent setting of a project. Use "permission" and "allow".`);
  const out = {};
  if (input.permission) {
    if (!tool.permissionModes.some((mode) => mode.id === input.permission)) throw new Error(`permission must be one of ${tool.permissionModes.map((mode) => mode.id).join(', ')}, or empty for the machine's setting; got ${JSON.stringify(input.permission)}.`);
    out.permission = input.permission;
  }
  const allow = input.allow ?? [];
  if (!Array.isArray(allow) || allow.length > MAX_ALLOW) throw new Error(`"allow" must be a list of at most ${MAX_ALLOW} command prefixes.`);
  if (allow.some((item) => typeof item !== 'string')) throw new Error('Every allowed command must be text, such as "npm test".');
  const prefixes = allow.map((item) => item.trim()).filter(Boolean);
  for (const prefix of prefixes) {
    // A prefix becomes a permission rule; brackets, wildcards and line breaks would change what the rule means.
    if (prefix.length > MAX_PREFIX || /[()*\n\r]/.test(prefix)) throw new Error(`An allowed command must be one line of at most ${MAX_PREFIX} characters without brackets or "*", such as "npm test"; got ${JSON.stringify(prefix.slice(0, 60))}.`);
  }
  if (prefixes.length) out.allow = [...new Set(prefixes)];
  return out;
}

/** Returns what a session on this project may do: the permission mode and, for the scoped mode, the command prefixes. */
export function sessionPolicy(repo, settings = agentSettings(), worktree = '') {
  const own = repo.agent && typeof repo.agent === 'object' ? repo.agent : {};
  const tool = harness(settings.harness);
  const permission = tool.permissionModes.some((mode) => mode.id === own.permission) ? own.permission : settings.permission;
  const project = [repo.install, ...repo.gates.map((gate) => gate.cmd), ...(Array.isArray(own.allow) ? own.allow : [])].filter((cmd) => typeof cmd === 'string' && cmd.trim() && !/[()*\n\r]/.test(cmd)).map((cmd) => cmd.trim());
  const elsewhere = worktree && !/[()\n\r']/.test(worktree) ? GIT_READS.flatMap((word) => [`git -C ${worktree} ${word}`, `git -C '${worktree}' ${word}`]) : [];
  return { permission, allow: [...new Set([cliText(), 'codeignite', 'cig', 'factory', ...GIT_ALLOWED, ...elsewhere, ...HELPERS, ...project])], deny: DENIED };
}

// ----- the share of the plan limit -----

const usagePath = () => path.join(factoryRoot(), 'cache', 'plan-usage.json');

/** Returns what the harness last reported about the plan's usage windows: { at, windows }, or null. */
export function planUsage() {
  try {
    const kept = JSON.parse(fs.readFileSync(usagePath(), 'utf8'));
    if (!kept || !Array.isArray(kept.windows) || typeof kept.at !== 'string' || !Number.isFinite(Date.parse(kept.at))) return null;
    // A file edited by hand may hold anything; a window that is not one is left out.
    return { ...kept, windows: kept.windows.filter((window) => window && typeof window === 'object' && typeof window.id === 'string' && Number.isFinite(window.used) && window.used >= 0) };
  } catch {
    return null;
  }
}

/**
 * Returns the usage window that is at or past the share the user set, or null. A window whose reset time
 * has passed says nothing about now. `extra` raises the share by that many points.
 */
export function overCap(settings = agentSettings(), usage = planUsage(), extra = 0) {
  if (!settings.usageCap || !usage) return null;
  const now = Date.now() / 1000;
  const over = usage.windows.filter((window) => window.used * 100 >= Math.min(100, settings.usageCap + extra) && (!window.resetsAt || window.resetsAt > now));
  if (!over.length) return null;
  const worst = over.sort((a, b) => b.used - a.used)[0];
  return { ...worst, text: `Your ${WINDOW_NAMES[worst.id] || worst.id} plan usage is at ${Math.round(worst.used * 100)}%, and agents pause at ${settings.usageCap}%.${worst.resetsAt ? ` It resets ${new Date(worst.resetsAt * 1000).toLocaleString()}. Run the agent again after that, or change the share under Settings.` : ' Ask for the figure again under Settings, or change the share there.'}` };
}

/**
 * Asks the harness for the plan's usage with its smallest request and keeps the answer. Resolves with what was
 * kept: { at, windows, silent }. `silent` means the harness answered and reported no usage, as with an API key.
 */
export function checkUsage(settings = agentSettings(), tool = harness(settings.harness), control = null) {
  // Several askers at one moment share one request.
  if (!asking) asking = { children: new Set(), promise: null };
  const shared = asking;
  if (control) control.probe = () => { for (const child of shared.children) child.kill('SIGKILL'); };
  shared.promise ||= askUsage(settings, tool, shared.children).finally(() => { if (asking === shared) asking = null; });
  return shared.promise;
}
let asking = null;

function askUsage(settings, tool, children) {
  return new Promise((resolve) => {
    if (typeof tool.probe !== 'function') return resolve(planUsage());
    const { cmd, args, env } = tool.probe({ account: settings.account });
    let windows = null;
    let answered = false;
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(planUsage());
    }
    children.add(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
    eachLine(child.stdout, (line) => {
      try {
        for (const event of tool.parse(line)) {
          if (event.type === 'usage') windows = event.windows;
          // Only a finished answer counts: a request that started and died says nothing about the plan.
          if (event.type === 'result') answered = true;
        }
      } catch { /* A line that cannot be read is skipped. */ }
    });
    child.on('error', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      children.delete(child);
      // No answer at all (not installed, not logged in) says nothing; the last figure stays.
      if (!windows && !answered) return resolve(planUsage());
      const kept = { at: new Date().toISOString(), windows: windows || [], silent: !windows };
      try { writeJson(usagePath(), kept); } catch { /* Used for this run all the same. */ }
      return resolve(kept);
    });
  });
}

// ----- the cost of a day -----

const spendPath = () => path.join(factoryRoot(), 'cache', 'spend.json');
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };

/** Returns what Claude Code estimated for today's sessions on this machine: { day, usd, sessions }. */
export function spendToday() {
  try {
    const kept = JSON.parse(fs.readFileSync(spendPath(), 'utf8'));
    if (kept.day === today() && Number.isFinite(kept.usd)) return { day: kept.day, usd: kept.usd, sessions: Number(kept.sessions) || 0 };
  } catch {
    // Nothing recorded yet.
  }
  return { day: today(), usd: 0, sessions: 0 };
}

// Adds a session's estimated cost to the day. Sessions of the board and of "codeignite work" may end together.
function addSpend(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return;
  try {
    withLock(`${spendPath()}.lock`, () => {
      const now = spendToday();
      writeJson(spendPath(), { day: now.day, usd: Math.round((now.usd + usd) * 1e6) / 1e6, sessions: now.sessions + 1 });
    }, { wait: 2000, what: 'the cost of the day' });
  } catch { /* A figure that could not be added must not end a run. */ }
}

/** Returns the reason agents are paused for the day's cost, or null. */
export function overBudget(settings = agentSettings()) {
  if (!settings.dailyBudget) return null;
  const spent = spendToday();
  if (spent.usd < settings.dailyBudget) return null;
  return { ...spent, text: `Claude Code estimates today's ${spent.sessions} session(s) at $${spent.usd.toFixed(2)}, and agents pause at $${settings.dailyBudget} a day. It starts again tomorrow; raise the amount under Settings to go on today. The figure is an estimate, not a bill.` };
}

// ----- the record of a run -----

/** Returns the stored record of the task's last run, or null. A run whose supervising process is gone reads as interrupted. */
export function readRun(id) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(runPath(id), 'utf8'));
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || !Array.isArray(record.sessions)) return null;
  // A record edited by hand, or cut off while written, must not take the task off the board.
  record.sessions = record.sessions.filter((session) => session && typeof session === 'object');
  // The process id alone is not proof: after a crash the system may give it to another program.
  // Every record of a run in flight says when it was last alive; one that does not, or says a time that cannot be, is not in flight.
  const age = Date.now() - Date.parse(record.beat);
  const silent = !(age <= 3 * BEAT_MS) || age < -BEAT_MS;
  if (['running', 'queued'].includes(record.status) && (!alive(record.supervisor) || silent)) {
    return { ...record, status: 'ended', reason: 'interrupted', detail: REASONS.interrupted, endedAt: record.endedAt || null };
  }
  return record;
}

/** Returns what the board shows of the task's last run: no command text, no paths besides the log. */
export function runView(id) {
  const record = readRun(id);
  if (!record) return null;
  const last = record.sessions.at(-1) || null;
  return {
    status: record.status,
    reason: record.reason || null,
    detail: record.detail || null,
    harness: record.harnessLabel || record.harness,
    permission: record.permission,
    startedAt: record.startedAt,
    endedAt: record.endedAt || null,
    sessions: record.sessions.length,
    stage: last?.stage || null,
    model: last?.model || null,
    account: last?.account || null,
    said: typeof last?.said === 'string' ? last.said.slice(0, MAX_SAID) : null,
    denials: [...new Set(record.sessions.flatMap((session) => (Array.isArray(session.denials) ? session.denials : [])).filter((item) => typeof item === 'string'))].slice(0, 40),
    costUsd: record.sessions.some((session) => Number.isFinite(session.costUsd)) ? record.sessions.reduce((sum, session) => sum + (Number.isFinite(session.costUsd) ? session.costUsd : 0), 0) : null,
    limit: record.limit || null,
    log: fs.existsSync(logPath(id)) ? `issues/${id}/agent.log` : null,
  };
}

/** Returns the reason a task has nothing for an agent to do, or null when an agent can work on it. */
export function haltReason(state) {
  if (state.archived) return 'archived';
  if (state.blocked) return 'blocked';
  if (HUMAN_STAGES.includes(state.stage)) return 'your-turn';
  return null;
}

// What only the Codeignite CLI writes: the task's state, its evidence, the verifier's report and the run record.
const protectedFiles = (id) => [path.join(issueDir(id), 'state.json'), path.join(issueDir(id), 'evidence', '**'), path.join(issueDir(id), 'verify.md'), runPath(id)];

// The first message of a session. One stage per session keeps each context fresh and gives the verifier its own.
function stagePrompt(state, model) {
  const cli = cliText();
  return [
    `Work on the Codeignite task ${state.id}. Start by running: ${cli} next ${state.id}`,
    `Do only the current stage ("${state.stage}"). Follow its brief, then run: ${cli} advance ${state.id}`,
    'Stop as soon as the task has moved to another stage or is blocked. Do not start the next stage: a fresh session takes it.',
    model ? `This session already runs on the model the brief names (${model}), so do the step yourself.` : '',
    'You run unattended. Nobody can answer a question or approve a command. A refused command stays refused: do not look for another way to run it. If you cannot finish the stage, say why in your last message and stop.',
  ].filter(Boolean).join('\n');
}

// Describes one tool call as a log line: names only.
const callLine = (event) => `  ${event.kind === 'tool' ? event.label : `${event.kind} ${event.label}`}${event.detail ? ` ${event.detail}` : ''}`;

/**
 * Runs sessions on a task until it needs the user. Resolves with the finished record.
 * `control.stopped` ends the run before the next session; `control.child` is the running session's process.
 */
export async function runTask(id, { control = {}, tool: given = null, settings: fixed = null, onChange = () => {} } = {}) {
  // Without settings of its own the run reads them before every session, so a brake changed meanwhile holds for it.
  let settings = fixed || agentSettings();
  const tool = given || harness(settings.harness);
  // A session of an earlier run whose supervisor died is still at work in the folder; it goes before this run starts.
  endOrphan(id);
  const first = sync(loadState(id));
  // The mode is shown on the board; a project that cannot be read is reported by the loop below, not here.
  let permission = settings.permission;
  try { permission = sessionPolicy(getRepo(first.repo), settings).permission; } catch { /* Reported below. */ }
  const record = { id, status: 'running', reason: null, detail: null, harness: tool.id, harnessLabel: tool.label, permission, supervisor: process.pid, startedAt: new Date().toISOString(), endedAt: null, limit: null, sessions: [] };
  const save = () => {
    record.beat = new Date().toISOString();
    writeJson(runPath(id), record);
    onChange(record);
  };
  // Keeps the record fresh while a session is quiet, without telling the board anything changed.
  const beat = setInterval(() => { if (record.status === 'running') { record.beat = new Date().toISOString(); writeJson(runPath(id), record); } }, BEAT_MS);
  beat.unref();
  // A log left full by earlier runs keeps its end, so this run is recorded too.
  if (fs.existsSync(logPath(id)) && fs.statSync(logPath(id)).size > MAX_LOG_BYTES / 2) fs.writeFileSync(logPath(id), `Earlier lines were dropped.\n${fs.readFileSync(logPath(id), 'utf8').slice(-MAX_LOG_BYTES / 8)}`);
  let logged = fs.existsSync(logPath(id)) ? fs.statSync(logPath(id)).size : 0;
  const log = (text) => {
    if (logged > MAX_LOG_BYTES) return;
    const line = `${text}\n`;
    logged += Buffer.byteLength(line);
    fs.appendFileSync(logPath(id), logged > MAX_LOG_BYTES ? `${line}The log is full; later lines are not kept.\n` : line);
  };
  const finish = (reason, detail = '') => {
    record.status = 'ended';
    record.reason = reason;
    record.detail = [REASONS[reason], detail].filter(Boolean).join(' ');
    record.endedAt = new Date().toISOString();
    clearInterval(beat);
    log(`[${record.endedAt}] Run ended: ${record.detail}`);
    save();
    return record;
  };

  log(`\n[${record.startedAt}] Run started with ${tool.label}, permission mode "${record.permission}".`);
  save();
  if (!tool.version()) return finish('missing', tool.install);
  // The brake works from what the harness last reported; a figure that is old or missing is asked for first.
  if (settings.usageCap) {
    const known = planUsage();
    if (!known || Date.now() - Date.parse(known.at) > USAGE_FRESH_MS) await checkUsage(settings, tool, control);
    control.probe = null;
    if (control.stopped) return finish('stopped');
  }

  let idle = 0;
  for (;;) {
    let state, repo;
    try {
      state = sync(loadState(id));
      repo = getRepo(state.repo);
    } catch (err) {
      // The task or its project went away while the run was going.
      return finish('error', err.message);
    }
    const halt = haltReason(state);
    if (halt) return finish(halt, state.blocked?.reason || '');
    if (control.stopped) return finish('stopped');
    if (!fixed) {
      try { settings = agentSettings(); } catch (err) { return finish('error', err.message); }
    }
    if (!stagesOf(state).includes(state.stage)) return finish('error', `The task is at "${state.stage}", which is not a step of its workflow.`);
    // Without this a missing folder reads as a missing program: both fail to start the session.
    if (!state.worktree || !fs.existsSync(state.worktree)) return finish('error', `The worktree of ${id} is missing: ${state.worktree}.`);
    // A task made before ports existed gets one now, so its sessions are told it like any other's.
    if (!Number.isInteger(state.port)) {
      try { state.port = ensurePort(id) ?? undefined; } catch { /* The session runs without a port. */ }
    }
    // Codeignite acts at intake: the issue and the worktree exist, so the task moves on without a session.
    if (state.stage === 'intake') {
      const moved = withTask(id, () => advance(loadState(id), repo));
      if (!moved.moved) return finish('error', moved.problems.join(' '));
      continue;
    }
    // The brake: no new session while the plan is used up to the share the user keeps for their own work.
    const full = overCap(settings);
    if (full) return finish('usage', full.text);
    const spent = overBudget(settings);
    if (spent) return finish('budget', spent.text);
    if (record.sessions.length >= settings.maxSessions) return finish('limit', `The limit is ${settings.maxSessions} sessions per run. Run the agent again to continue.`);

    const workflow = resolveWorkflow(state.repo);
    const model = workflow[state.kind === 'review' ? 'review' : 'stages'][state.stage]?.model || '';
    const policy = sessionPolicy(repo, settings, state.worktree);
    const session = { stage: state.stage, model, sessionId: null, account: null, startedAt: new Date().toISOString(), endedAt: null, ok: null, reason: null, turns: null, costUsd: null, denials: [], said: null };
    record.sessions.push(session);
    save();
    log(`[${session.startedAt}] Session ${record.sessions.length}: stage "${state.stage}"${model ? `, model ${model}` : ''}.`);

    let reported = false;
    let counted = false;
    control.onSpawn = (pid, cmd) => { record.session = pid ? { pid, cmd } : null; save(); };
    const exit = await runSession(tool, { prompt: stagePrompt(state, model), model, account: settings.account, dirs: [issueDir(id)], protect: protectedFiles(id), secret: [keyPath()], ...policy }, state.worktree, control, settings.sessionMinutes * 60_000, taskEnv(state), (event) => {
      if (event.type === 'session') {
        session.sessionId = event.sessionId;
        session.account = event.account || null;
        save();
      } else if (event.type === 'text') {
        session.said = event.text.slice(0, MAX_SAID);
        log(event.text);
      } else if (event.type === 'tool') {
        log(callLine(event));
      } else if (event.type === 'usage') {
        reported = true;
        // Kept for every run on this machine: the plan is one, whichever task uses it.
        try { writeJson(usagePath(), { at: new Date().toISOString(), windows: event.windows }); } catch { /* The brake then works from the last figure it has. */ }
        // Well past the share, the session is interrupted; just past it, it may finish its step first.
        if (control.child && overCap(settings, { windows: event.windows }, HARD_STOP_POINTS)) {
          control.usageStop = true;
          endTree(control.child);
        }
      } else if (event.type === 'limit') {
        record.limit = { status: event.status, resetsAt: event.resetsAt ? new Date(event.resetsAt * 1000).toISOString() : null };
        log(`The account's usage limit answered "${event.status}".`);
        save();
      } else if (event.type === 'result') {
        // One session, one cost: a harness that reports its result twice is counted once.
        if (!counted) addSpend(event.costUsd);
        counted = true;
        Object.assign(session, { ok: event.ok, reason: event.reason, turns: event.turns, costUsd: event.costUsd, denials: event.denials.map((call) => callLine(call).trim()) });
        if (event.text) session.said = event.text.slice(0, MAX_SAID);
      }
    });
    session.endedAt = new Date().toISOString();
    // A session that ran and reported no usage leaves the share brake without a figure; Settings says so.
    if (!reported && session.ok !== null && settings.usageCap) {
      try { writeJson(usagePath(), { at: session.endedAt, windows: [], silent: true }); } catch { /* Said on the next session. */ }
    }
    // Token counts come from the session's own file, when the harness wrote one.
    const transcript = session.sessionId ? tool.transcript(state.worktree, session.sessionId) : null;
    if (transcript) linkSession(id, transcript);
    if (session.denials.length) log(`Refused: ${session.denials.join(', ')}`);
    save();

    if (control.stopped) return finish('stopped');
    if (control.usageStop) return finish('usage', overCap(settings)?.text || '');
    if (exit.timedOut) return finish('timeout', `The limit is ${settings.sessionMinutes} minutes per session; change it under Settings. Committed work stays.`);
    if (exit.error) return finish('error', exit.error);
    if (session.ok === false) return finish('error', `${session.reason || 'It reported an error'}${session.said ? `: ${session.said.slice(0, 300)}` : '.'}`);
    if (session.ok === null) return finish('error', `It ${exit.signal ? `was ended by ${exit.signal}` : `exited with code ${exit.code}`} and reported no result.${exit.stderr ? ` ${exit.stderr}` : ''}`);

    const after = sync(loadState(id));
    idle = after.stage === state.stage && !after.blocked ? idle + 1 : 0;
    if (idle >= MAX_IDLE) return finish('stalled', session.denials.length ? `Refused commands: ${session.denials.join(', ')}. Allow them for the project if the agent needs them.` : 'Read its last message, then run it again or work on the task yourself.');
  }
}

// Reads a stream line by line. A line longer than MAX_LINE is dropped whole: kept, it would grow until the process fails.
function eachLine(stream, onLine) {
  let buffer = '';
  let dropping = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    let rest = chunk;
    for (let at = rest.indexOf('\n'); at !== -1; at = rest.indexOf('\n')) {
      const line = buffer + rest.slice(0, at);
      rest = rest.slice(at + 1);
      buffer = '';
      if (dropping) dropping = false;
      else if (line.trim()) onLine(line);
    }
    if (dropping) return;
    buffer += rest;
    if (buffer.length > MAX_LINE) {
      buffer = '';
      dropping = true;
    }
  });
  stream.on('end', () => { if (!dropping && buffer.trim()) onLine(buffer); });
  stream.on('error', () => {});
}

// Ends the session a dead supervisor left behind. The process id alone is not proof after a crash, so the program
// behind it must still be the harness.
function endOrphan(id) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(runPath(id), 'utf8'));
  } catch {
    return;
  }
  const session = record?.session;
  if (!session || !Number.isInteger(session.pid) || session.pid <= 1 || process.platform === 'win32') return;
  if (record.supervisor === process.pid && record.status === 'running') return;
  const seen = spawnSync('ps', ['-o', 'command=', '-p', String(session.pid)], { encoding: 'utf8' }).stdout || '';
  if (!seen.trim() || !seen.includes(String(session.cmd || '\u0000'))) return;
  try { process.kill(-session.pid, 'SIGKILL'); } catch { /* Gone already. */ }
}

// Signals a session and every command it started. A session has its own process group where the system has them.
function signalTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The group is gone already.
  }
}
// Ends a session: an interrupt lets it finish its turn, and a kill follows when it does not leave.
function endTree(child) {
  signalTree(child, 'SIGINT');
  setTimeout(() => signalTree(child, 'SIGKILL'), KILL_AFTER_MS).unref();
}

// Runs one session and reports its events. Resolves with { code, error, stderr } once the process is gone.
function runSession(tool, options, cwd, control, limitMs, taskVars, onEvent) {
  return new Promise((resolve) => {
    let timedOut = false;
    const { cmd, args, env } = tool.command(options);
    Object.assign(env, taskVars);
    let child;
    try {
      // Its own process group, so ending the session also ends the commands it started.
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (err) {
      return resolve({ code: null, error: `It could not be started: ${err.message}`, stderr: '' });
    }
    control.child = child;
    control.onSpawn?.(child.pid, path.basename(cmd));
    // A session that never ends would hold its slot for good; an interrupt first, then a kill.
    const limit = setTimeout(() => {
      timedOut = true;
      endTree(child);
    }, limitMs);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-600); });
    let leave = null;
    eachLine(child.stdout, (line) => {
      // A line that cannot be read or recorded must not end the session, or the process that runs it.
      try {
        for (const event of tool.parse(line)) {
          onEvent(event);
          // The work is done once the result is in; a session that stays after it holds its slot for nothing.
          if (event.type === 'result') leave ||= setTimeout(() => endTree(child), LEAVE_AFTER_MS).unref();
        }
      } catch { /* The next line is read as usual. */ }
    });
    let failed = null;
    child.on('error', (err) => { failed = err.code === 'ENOENT' ? `"${cmd}" was not found. ${tool.install}` : `It could not be started: ${err.message}`; });
    let done = false;
    const end = (code, signal) => {
      if (done) return;
      done = true;
      control.child = null;
      control.onSpawn?.(null);
      clearTimeout(limit);
      clearTimeout(leave);
      // Whatever the session left running goes with it.
      signalTree(child, 'SIGKILL');
      resolve({ code, signal: signal || null, error: failed, timedOut, stderr: stderr.trim().split('\n').at(-1) || '' });
    };
    child.on('close', end);
    // A command the session left in the background keeps its output open, and "close" would wait for that command.
    child.on('exit', (code, signal) => setTimeout(() => end(code, signal), DRAIN_MS).unref());
  });
}

// ----- the queue -----

/**
 * Keeps the runs of one process: at most `maxConcurrent` at a time, the rest wait in order.
 * Returns { start, stop, active, queued, close }.
 */
export function createRunner({ onChange = () => {}, tool = null } = {}) {
  const running = new Map();
  const waiting = [];
  const queuedRecord = (id, startedAt = new Date().toISOString()) => writeJson(runPath(id), { id, status: 'queued', reason: null, detail: null, supervisor: process.pid, startedAt, beat: new Date().toISOString(), endedAt: null, sessions: [] });
  const ended = (id, reason, detail = '') => {
    // A task whose folder is gone gets no record: writing one would bring the folder back.
    if (!fs.existsSync(issueDir(id))) return;
    try { writeJson(runPath(id), { id, status: 'ended', reason, detail: [REASONS[reason], detail].filter(Boolean).join(' '), supervisor: process.pid, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), sessions: [] }); } catch { /* Nothing to record it in. */ }
  };
  // A waiting run says it still waits, so a record left by a process that died is told from a live one.
  const beat = setInterval(() => {
    for (const id of waiting) {
      try { if (fs.existsSync(issueDir(id))) queuedRecord(id, readRun(id)?.startedAt); } catch { /* Tried again on the next beat. */ }
    }
  }, BEAT_MS);
  beat.unref();

  function launch(id) {
    const control = { stopped: false, child: null };
    running.set(id, control);
    runTask(id, { control, tool: tool || null, onChange })
      .catch((err) => {
        // A run that cannot even be recorded still frees its slot and leaves the reason behind.
        try {
          // What the run recorded so far stays: its sessions, their cost and the refused commands.
          const prior = readRun(id);
          if (fs.existsSync(issueDir(id))) writeJson(runPath(id), { startedAt: new Date().toISOString(), ...(prior || {}), id, status: 'ended', reason: 'error', detail: `${REASONS.error} ${err.message}`, supervisor: process.pid, endedAt: new Date().toISOString(), sessions: prior?.sessions || [] });
        } catch { /* The task folder is gone; nothing to record. */ }
      })
      .finally(() => {
        running.delete(id);
        onChange();
        next();
      });
  }
  function next() {
    let max;
    try {
      max = agentSettings().maxConcurrent;
    } catch (err) {
      // Settings that cannot be read: the waiting runs end with the reason, and the process goes on.
      for (const id of waiting.splice(0)) ended(id, 'error', err.message);
      onChange();
      return;
    }
    while (waiting.length && running.size < max) launch(waiting.shift());
  }
  // Ends a session: an interrupt lets it finish its turn, and a kill follows when it does not leave.
  function end(control) {
    control.stopped = true;
    control.probe?.();
    if (control.child) endTree(control.child);
  }

  return {
    /** Starts a run, or puts it in the queue. Returns 'running' or 'queued'. */
    start(id) {
      const state = sync(loadState(id));
      if (running.has(id) || waiting.includes(id)) throw new Error(`An agent already runs on ${id}, or waits to.`);
      const other = readRun(id);
      if (other && ['running', 'queued'].includes(other.status)) throw new Error(`Another process (${other.supervisor}) runs an agent on ${id}. Stop it there first.`);
      const halt = haltReason(state);
      if (halt) throw new Error(`${id} has nothing for an agent to do. ${REASONS[halt]}`);
      if (!fs.existsSync(state.worktree)) throw new Error(`The worktree of ${id} is missing: ${state.worktree}.`);
      if (settingUp(id)) throw new Error(`The setup command of ${id} is still running. Run the agent when it has finished.`);
      // An old figure does not refuse a start: the run asks for a new one first and decides on that.
      const usage = planUsage();
      const full = usage && Date.now() - Date.parse(usage.at) <= USAGE_FRESH_MS ? overCap(agentSettings(), usage) : null;
      if (full) throw new Error(`${REASONS.usage} ${full.text}`);
      const spent = overBudget();
      if (spent) throw new Error(`${REASONS.budget} ${spent.text}`);
      if (running.size < agentSettings().maxConcurrent) {
        launch(id);
        return 'running';
      }
      waiting.push(id);
      queuedRecord(id);
      onChange();
      return 'queued';
    },
    /** Stops the task's run or takes it out of the queue. Returns false when there was none. */
    stop(id) {
      const at = waiting.indexOf(id);
      if (at !== -1) {
        waiting.splice(at, 1);
        ended(id, 'stopped');
        onChange();
        return true;
      }
      const control = running.get(id);
      if (!control) return false;
      end(control);
      return true;
    },
    active: () => [...running.keys()],
    queued: () => [...waiting],
    /** Starts waiting runs that now have room, as after the number of agents at once was raised. */
    kick: () => next(),
    /** Ends every session; called when the process that owns them stops. */
    close() {
      clearInterval(beat);
      for (const id of waiting.splice(0)) ended(id, 'interrupted');
      for (const control of running.values()) {
        control.stopped = true;
        // The owner is about to exit and cannot wait for a turn to finish.
        if (control.child) signalTree(control.child, 'SIGKILL');
      }
    },
  };
}

/** Returns what the settings page needs: the settings, the harness and its choices, and whether it is installed. */
export function agentsOverview() {
  const settings = agentSettings();
  const tool = harness(settings.harness);
  return { settings, limits: LIMITS, planUsage: planUsage(), spend: spendToday(), harness: { id: tool.id, label: tool.label, version: tool.version(), install: tool.install, permissionModes: tool.permissionModes, accounts: tool.accounts }, harnesses: harnesses().map((item) => ({ id: item.id, label: item.label })) };
}
