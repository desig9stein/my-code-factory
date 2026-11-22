// Starts Claude Code without a terminal and reads what it reports. The program is the user's own installation,
// so it uses the login they already have; Codeignite never reads or stores a credential.
import { setting } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeCall } from './activity.mjs';
import { run } from './sh.mjs';

// CODEIGNITE_CLAUDE_BIN points the tests, or an unusual installation, at another program.
const bin = () => setting('CLAUDE_BIN') || 'claude';
// Variables that make Claude Code bill an API key or another provider instead of the user's login.
const KEY_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
// Set inside a Claude Code session; a session Codeignite starts is not a child of the one that started the board.
const SESSION_VARIABLES = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];
// A rule is "Tool(prefix:*)": the command must start with the prefix.
const bashRule = (prefix) => `Bash(${prefix}:*)`;

export const claude = {
  id: 'claude',
  label: 'Claude Code',
  install: 'Install Claude Code from https://claude.com/claude-code and run "claude" once in a terminal to log in.',
  permissionModes: [
    { id: 'scoped', label: 'Edits and listed commands', about: 'The agent edits files in the task\'s folder and runs the Codeignite commands, Git without push, and the project\'s install and check commands, plus any commands you list for the project. Everything else is refused and reported on the task.' },
    { id: 'auto', label: 'Claude Code auto mode', about: 'Claude Code decides per command whether it is safe to run. Fewer refusals, less predictable. Your Claude Code version and plan must offer auto mode.' },
    { id: 'own', label: 'My own Claude Code settings', about: 'Codeignite adds no rule. What your Claude Code settings allow runs; anything they would ask you about is refused, because nobody is there to answer.' },
  ],
  accounts: [
    { id: 'login', label: 'My Claude login', about: `The session uses the account you logged in to Claude Code with. ${KEY_VARIABLES.join(' and ')} are not passed on, so an API key in your shell is not billed by accident.` },
    { id: 'environment', label: 'Whatever my shell has', about: `The session gets your environment unchanged. If ${KEY_VARIABLES[0]} is set, Claude Code bills that key instead of your login.` },
  ],

  version() {
    const result = run(bin(), ['--version']);
    return result.status === 0 ? result.stdout.split('\n')[0].trim() || 'installed' : null;
  },

  command({ prompt, model = '', permission = 'scoped', allow = [], deny = [], dirs = [], protect = [], secret = [], account = 'login' }) {
    // stream-json prints one event per line; Claude Code asks for --verbose with it in print mode.
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);
    // Folders outside the session's own that it works in: the task's documents live beside the worktree, not in it.
    if (dirs.length) args.push('--add-dir', ...dirs);
    // Files no session may write, in every mode. A rule path that starts with "//" is absolute.
    const refused = [...protect.map((file) => `Edit(/${file})`), ...secret.flatMap((file) => [`Read(/${file})`, `Edit(/${file})`])];
    if (permission === 'scoped') {
      args.push('--permission-mode', 'acceptEdits');
      if (allow.length) args.push('--allowedTools', ...allow.map(bashRule));
      refused.unshift(...deny.map(bashRule));
    } else if (permission === 'auto') {
      args.push('--permission-mode', 'auto');
    }
    if (refused.length) args.push('--disallowedTools', ...refused);
    const env = { ...process.env };
    for (const name of SESSION_VARIABLES) delete env[name];
    if (account === 'login') for (const name of KEY_VARIABLES) delete env[name];
    return { cmd: bin(), args, env };
  },

  // The smallest request there is: one short answer from the fastest model, no tools, nothing kept. Its only use
  // is that Claude Code reports the plan's usage with it.
  probe({ account = 'login' } = {}) {
    const { cmd, env } = this.command({ prompt: '', permission: 'own', account });
    return { cmd, args: ['-p', 'Reply with the single word: ok', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--max-turns', '1', '--tools', '', '--strict-mcp-config', '--no-session-persistence'], env };
  },

  parse(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (!event || typeof event !== 'object') return [];
    if (event.type === 'system' && event.subtype === 'init') {
      return [{ type: 'session', sessionId: String(event.session_id || ''), model: String(event.model || ''), account: String(event.apiKeySource || '') }];
    }
    if (event.type === 'assistant') {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      return blocks.flatMap((block) => {
        if (!block || typeof block !== 'object') return [];
        if (block.type === 'text' && String(block.text || '').trim()) return [{ type: 'text', text: String(block.text).trim() }];
        if (block.type === 'tool_use') return [{ type: 'tool', ...describeCall({ tool_name: block.name, tool_input: block.input }) }];
        return [];
      });
    }
    if (event.type === 'rate_limit_event') {
      const info = event.rate_limit_info || {};
      // How much of each of the plan's usage windows is used, as a share from 0 to 1.
      const windows = Object.entries(info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {})
        // A window without a number says nothing; read as a number it would say "nothing used".
        .filter(([, window]) => window && typeof window.utilization === 'number')
        .map(([id, window]) => ({ id: String(id).slice(0, 40), used: Number(window?.utilization), resetsAt: Number(window?.resetsAt) || null }))
        .filter((window) => Number.isFinite(window.used) && window.used >= 0);
      return [
        ...(windows.length ? [{ type: 'usage', windows }] : []),
        ...(info.status && info.status !== 'allowed' ? [{ type: 'limit', status: String(info.status), resetsAt: Number(info.resetsAt) || null }] : []),
      ];
    }
    if (event.type === 'result') {
      const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
      return [{
        type: 'result',
        ok: event.is_error !== true && event.subtype === 'success',
        reason: String(event.subtype || ''),
        text: String(event.result || (Array.isArray(event.errors) ? event.errors.join(' ') : '') || '').trim(),
        turns: Number.isFinite(event.num_turns) ? event.num_turns : null,
        costUsd: Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null,
        // Names only, like the activity record: a refused command is reduced to its program.
        denials: denials.map((denial) => describeCall({ tool_name: denial.tool_name, tool_input: denial.tool_input })),
      }];
    }
    return [];
  },

  transcript(cwd, sessionId) {
    if (!cwd || !/^[\w-]+$/.test(sessionId || '')) return null;
    // Claude Code names a session's folder after the directory it started in, with every other character as "-".
    const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
    return fs.existsSync(file) ? file : null;
  },
};
