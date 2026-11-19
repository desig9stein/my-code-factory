#!/usr/bin/env node
// Claude Code hook entry for the factory.
// Usage: guard.mjs pre | post | session   (reads the hook payload from stdin)
import fs from 'node:fs';
import { writeBoard } from '../lib/board.mjs';
import { decide, inWorkspace } from '../lib/guard.mjs';
import { namesId } from '../lib/paths.mjs';
import { listStates } from '../lib/state.mjs';
import { linkSession } from '../lib/tokens.mjs';

const mode = process.argv[2];
let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  input = {};
}

try {
  if (mode === 'pre') {
    const d = decide(input);
    if (d.deny) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason },
        }),
      );
    }
  } else if (mode === 'post') {
    const states = listStates();
    const text = `${input.cwd || ''} ${JSON.stringify(input.tool_input || {})}`;
    // Links this session to every issue the tool call names or runs inside.
    for (const s of states) if (namesId(text, s.id)) linkSession(s.id, input.transcript_path);
    if (inWorkspace(input.cwd) && states.length) writeBoard();
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
