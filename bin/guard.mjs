#!/usr/bin/env node
// Claude Code hook entry for the factory.
// Usage: guard.mjs pre | post | session   (reads the hook payload from stdin)
import fs from 'node:fs';
import path from 'node:path';
import { writeBoard } from '../lib/board.mjs';
import { decide, inWorkspace } from '../lib/guard.mjs';
import { recordActivity, tasksOf } from '../lib/activity.mjs';
import { factoryRoot } from '../lib/paths.mjs';
import { listStates, peekStates } from '../lib/state.mjs';
import { linkSession } from '../lib/tokens.mjs';

const mode = process.argv[2];
function staleBoardFile() {
  try {
    return Date.now() - fs.statSync(path.join(factoryRoot(), 'board-data.js')).mtimeMs > 30_000;
  } catch {
    return true;
  }
}
let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  input = {};
}

try {
  if (mode === 'pre') {
    const d = decide(input);
    // An allowed call is recorded as it starts, so the board can show work in progress.
    if (!d.deny) {
      try {
        recordActivity(peekStates(), input);
      } catch {
        // Recording is best effort and never blocks a tool call.
      }
    }
    if (d.deny) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason },
        }),
      );
    }
  } else if (mode === 'post') {
    const states = listStates();
    // Links this session to every issue the tool call names or runs inside.
    const touched = tasksOf(states, input);
    for (const s of touched) linkSession(s.id, input.transcript_path);
    // The static board file is refreshed for calls that concern a task, at most twice a minute:
    // rebuilding it on every call would slow the agent, and the server builds its own data on request.
    if (touched.length && staleBoardFile()) writeBoard();
  } else if (mode === 'session') {
    const states = inWorkspace(input.cwd) ? listStates() : [];
    if (states.length) {
      const lines = states.map((s) => `- ${s.id}: ${s.blocked ? 'blocked' : s.stage} (branch ${s.branch}, worktree ${s.worktree})`);
      process.stdout.write(
        `Codeignite, tasks in flight:\n${lines.join('\n')}\nWork on these only through the factory skill: "factory next <id>" prints what the current stage needs and which skills and agents to use.\n`,
      );
    }
  }
} catch (err) {
  // A guard failure refuses outward actions only when the payload asked for one.
  if (mode === 'pre' && /\bpush\b|gh\s+(pr|issue)/.test(JSON.stringify(input.tool_input || {}))) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `The factory guard failed (${err.message}), so it could not check this action.`,
        },
      }),
    );
  }
}
process.exit(0);
