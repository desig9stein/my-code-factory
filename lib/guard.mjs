// Decides whether a Claude Code tool call may run against Codeignite-owned work.
import fs from 'node:fs';
import path from 'node:path';
import { issuesDir, within, workspace, worktreesDir } from './paths.mjs';
import { getRepo, loadRegistry } from './registry.mjs';
import { tryGit } from './sh.mjs';
import { boardPort } from './port.mjs';
import { approvalIntact } from './stages.mjs';
import { listStates, unreadableStates } from './state.mjs';

// Options a command may carry before its subcommand, such as "git -C dir -c a=b push" or "cig --json approve".
const FLAGS = String.raw`(?:\s+(?:-C|-c|-R|--repo|--git-dir|--work-tree|--namespace|--prefix)(?:\s+|=)\S+|\s+--?[\w-]+(?:=\S+)?)*`;
// "push" as the Git subcommand. A commit message, a file name or "git stash push" that only says the word is not one.
const PUSH = new RegExp(String.raw`\bgit\b${FLAGS}\s+push\b`);
const GH_OUT = new RegExp(String.raw`\bgh\s+pr\b${FLAGS}\s+(create|comment|review|merge|close|edit|ready|reopen)\b|\bgh\s+issue\b${FLAGS}\s+(comment|close|edit|reopen|create|delete)\b`);
// The command under each of its names: codeignite, cig, and factory from before the rename. Some file systems do not tell capitals apart.
const CLI = String.raw`(?:codeignite|cig|factory)(?:\.mjs)?`;
const APPROVE = new RegExp(String.raw`${CLI}${FLAGS}\s+(approve|reject)\b`, 'i');
// Starting the board, moving the data, pairing, and hiding from the checks that the caller is an agent. A variable
// that is only read or searched for ("echo $CLAUDECODE", "grep CODEIGNITE_ROOT lib") is none of these.
const SERVE = new RegExp(String.raw`${CLI}${FLAGS}\s+(serve|migrate)\b|\b(CODEIGNITE|FACTORY)_(PORT|ROOT|WORKSPACE)=|\bCLAUDE_?CODE\w*=|(\s-u\s*|--unset[=\s]|\bunset\s[^;|&\n]*)(CLAUDE|CODEIGNITE_|FACTORY_)|\.board-key\b|\.b[\w-]*[*?[\]{]|/api/pair\b|/pair\?code=`, 'i');
const PROTECTED = /issues\/[^/\s]+\/(state\.json|st[\w.]*[*?[\]{]|evidence\b|ev[\w.]*[*?[\]{]|verify\.md|agent-run\.json|\.lock|\.setting-up)/;
// A whole task folder removed or renamed takes its record and its proof with it.
const TASK_GONE = /\b(rm|mv|rmdir|unlink|shred)\b[^|;&\n]*\bissues\/[\w.-]+\/?(\s|$)|\b(rm|mv|rmdir)\b[^|;&\n]*\bissues\/?(\s|$)/;
const WRITES = />|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\s+(-\w*i|--in-place)|\btruncate\b|\bdd\b|\bnode\s+(-e|-p|--eval|--print|--input-type)|\bpython3?\b|\bperl\b|\bruby\b|\bln\b|\bchmod\b|\btouch\b|\binstall\b|\bcurl\b|\bwget\b|\brsync\b|\bshred\b|\bunlink\b/;
// Codeignite's own code run as a one-line script reaches what the command refuses: approving, the pairing key, the board.
const LIBRARY = /\b(node|bun|deno)\b[^|;&\n]*(\s-e|\s-p|--eval|--print|--input-type)[^|;&\n]*\b(stages|pairing|server|migrate|state|evidence|lock|store|jobs|agents)\.mjs/;
const MCP_OUT = /^mcp__.*(push|create_pull_request|pull_request_create|update_pull_request|add_issue_comment|issues_add_comment|issue_write|update_issue|create_or_update_file|delete_file|create_branch|auto_merge|review|comment|merge_pull_request)/i;
const MCP_FILE = /^mcp__.*(write|edit|create|move|delete|remove|rename)/i;
const MAX_COMMAND = 50_000;

// A request through "gh api" that changes something: a method other than GET, or fields without a method, on what
// an approval covers; and a GraphQL mutation. Reading the comments or the files of a pull request is none of these.
function ghApiWrite(cmd) {
  for (const [part] of cmd.matchAll(/\bgh\s+api\b[^|;&\n]*/g)) {
    const method = /(?:\s-X|--method)[=\s]*(\w+)/i.exec(part)?.[1].toUpperCase();
    const fields = /\s(-f|-F|--field|--raw-field|--input)(\b|=)|\s-[fF]\S/.test(part);
    if (/\bgraphql\b/.test(part)) {
      if (/\bmutation\b/.test(part)) return true;
      continue;
    }
    if ((method ? method !== 'GET' : fields) && /\/(pulls|issues|git\/refs|contents|merges|releases|branches)\b/.test(part)) return true;
  }
  return /\bcurl\b[^|;&\n]*api\.github\.com[^|;&\n]*/.test(cmd) && /\s(-X|--request|-d|--data\S*|-F|--form\S*|-T)\b/.test(cmd);
}

// The same command as the shell would see it once quotes and backslashes are taken away: c\ig ap""prove is "cig approve".
const plain = (cmd) => cmd.replace(/\\([^\n])/g, '$1').replace(/["'`]/g, '').replace(/\/(\.?\/)+/g, '/');

const BOARD = () => new RegExp(`(127(\\.\\d+){1,3}|localhost|\\[::1?\\]|0(\\.0\\.0\\.0)?):${boardPort()}\\b`, 'i');
const BOARD_REASON = 'The Codeignite board is where the user approves. Agents do not open it or call its API. Read state with "codeignite status <id>".';

const allow = () => ({ deny: false });
const deny = (reason) => ({ deny: true, reason });

// Collects the directories a shell command may run in: cwd, "cd <dir>" and "-C <dir>".
function commandDirs(cmd, cwd) {
  const dirs = [cwd];
  for (const m of cmd.matchAll(/(?:\bcd|-C)\s+("([^"]+)"|'([^']+)'|(\S+))/g)) {
    dirs.push(path.resolve(cwd, m[2] || m[3] || m[4]));
  }
  // Git told where its repository is by a variable or an option works there, wherever the command runs.
  for (const m of cmd.matchAll(/(?:\bGIT_DIR=|--git-dir[=\s]+|\bGIT_WORK_TREE=|--work-tree[=\s]+)["']?([^\s"']+)/g)) {
    const dir = path.resolve(cwd, m[1]);
    dirs.push(path.basename(dir) === '.git' ? path.dirname(dir) : dir);
  }
  return dirs;
}

// Work may go out once approved at HEAD with the approved PR body or review draft unchanged.
const approvedAtHead = approvalIntact;

function refusal(s, what) {
  return deny(
    `Factory ${s.kind === 'review' ? 'review' : 'issue'} ${s.id} is at stage "${s.stage}", so ${what} is refused. It needs ${s.kind === 'review' ? "the user's approval of the unchanged draft" : "passing gates, a verifier pass and the user's approval of the unchanged pr-body.md"} at the current HEAD. Run "codeignite status ${s.id}" to see what is missing. Do not work around this block.`,
  );
}

function bashDecision(raw, cwd) {
  if (raw.length > MAX_COMMAND) return deny(`This command is ${raw.length} characters long, which is more than the Codeignite guard checks. Put it in a script file and run that.`);
  // Each rule looks at the command as written and as the shell reads it.
  const cmd = `${raw}\n${plain(raw)}`;
  if (APPROVE.test(cmd)) {
    return deny('Approval belongs to the user. Ask them to run "codeignite approve <id>" in their own terminal.');
  }
  if (SERVE.test(cmd)) return deny(BOARD_REASON);
  if (LIBRARY.test(cmd)) return deny('Codeignite\'s own code is not run as a one-line script from an agent session: that reaches what its command refuses. Use the "codeignite" command.');
  if (TASK_GONE.test(cmd)) return deny('A task folder holds the task\'s record and its proof. It is removed with "codeignite archive <id>", by the user.');
  const writes = WRITES.test(cmd.replace(/\d?>\s*(\/dev\/null|&\d)/g, ''));
  // The protected files are also reached by name alone from inside the task's own folder.
  const insideTask = commandDirs(raw, cwd).some((dir) => within(dir, issuesDir()) && path.relative(issuesDir(), dir) !== '') && /(^|[\s"'/>])(state\.json|st[\w.]*[*?[\]{]|evidence\b|verify\.md|agent-run\.json)/.test(cmd);
  if ((PROTECTED.test(cmd) || insideTask) && writes) {
    return deny('Factory state, evidence and verify.md are written only by the Codeignite CLI ("codeignite run", "codeignite advance", "codeignite verdict").');
  }
  const push = PUSH.test(cmd);
  const gh = GH_OUT.test(cmd) || ghApiWrite(cmd);
  if (!push && !gh) return allow();

  const registry = loadRegistry();
  const dirs = commandDirs(raw, cwd);
  const states = listStates();
  // A task whose record cannot be read cannot be checked, so nothing goes out while there is one.
  const unread = unreadableStates();
  if (unread.length) return deny(`The record of ${unread.map((u) => u.id).join(', ')} cannot be read, so the Codeignite guard cannot tell whether this ${push ? 'push' : 'GitHub action'} is approved. Tell the user; "codeignite status" names the problem.`);
  // A folder under Codeignite's worktrees that no task in flight owns is not approved work either.
  const stray = dirs.find((d) => within(d, worktreesDir()) && path.relative(worktreesDir(), d) !== '' && !states.some((s) => within(d, s.worktree)));
  if (stray) return deny(`${stray} is a Codeignite worktree that no task in flight owns, so nothing is pushed or posted from it.`);
  // A push of every branch, or of branches by pattern, takes the task's branch along without naming it.
  const broad = push && /\s--(all|mirror|branches)\b|\bpush\b[^|;&\n]*\*/.test(cmd);
  for (const s of states) {
    const repo = getRepo(s.repo, registry);
    if (broad && s.kind !== 'review' && dirs.some((d) => within(d, repo.dir) || within(d, s.worktree)) && !approvedAtHead(s)) return refusal(s, 'a push of every branch');
    const inWorktree = dirs.some((d) => within(d, s.worktree));
    const onBranch = dirs.some((d) => within(d, repo.dir) && tryGit(d, 'rev-parse', '--abbrev-ref', 'HEAD') === s.branch);
    const named = cmd.includes(s.branch) || cmd.includes(s.worktree);
    const sameRepo = cmd.includes(repo.remote) || dirs.some((d) => within(d, repo.dir) || within(d, s.worktree));
    const issueNamed = gh && sameRepo && new RegExp(`(^|[\\s/#])${s.issue}([\\s/]|$)`).test(cmd);
    if (!(inWorktree || onBranch || named || issueNamed)) continue;
    if (s.kind === 'review' && push) {
      return deny(`${s.id} is a review of someone else's pull request. Never push from its worktree.`);
    }
    if (!approvedAtHead(s)) return refusal(s, push ? 'a push' : 'a GitHub comment, review or PR');
  }
  return allow();
}

// Follows links: the folder a path really ends in, even when its last parts do not exist yet.
function realPath(file) {
  let dir = file;
  const rest = [];
  for (let n = 0; n < 64; n++) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch {
      const up = path.dirname(dir);
      if (up === dir) break;
      rest.unshift(path.basename(dir));
      dir = up;
    }
  }
  return file;
}

function fileDecision(filePath, cwd) {
  if (!filePath || typeof filePath !== 'string') return allow();
  const abs = realPath(path.resolve(cwd, filePath));
  const root = realPath(issuesDir());
  if (!within(abs, root)) return allow();
  const rel = path.relative(root, abs).split(path.sep).slice(1).join('/');
  if (rel === 'state.json' || rel === 'verify.md' || rel === 'agent-run.json' || rel === 'evidence' || rel.startsWith('evidence/')) {
    return deny('Factory state, evidence and verify.md are written only by the Codeignite CLI ("codeignite run", "codeignite advance", "codeignite verdict").');
  }
  return allow();
}

function mcpDecision(toolName, toolInput) {
  if (!MCP_OUT.test(toolName)) return allow();
  const text = JSON.stringify(toolInput || {});
  const registry = loadRegistry();
  for (const s of listStates()) {
    const repo = getRepo(s.repo, registry);
    const repoName = repo.remote.split('/')[1];
    const issueNamed = text.includes(repoName) && new RegExp(`[^0-9]${s.issue}[^0-9]`).test(text);
    if ((text.includes(s.branch) || text.includes(s.worktree) || issueNamed) && !approvedAtHead(s)) {
      return refusal(s, 'a push, PR or comment through an MCP tool');
    }
  }
  return allow();
}

/** Returns { deny, reason } for a PreToolUse payload. */
export function decide(input) {
  const cwd = input.cwd || process.cwd();
  const given = String(input.tool_name || '');
  // A shell under another spelling of its name is still a shell.
  const name = /^(bash|shell|sh|powershell)$/i.test(given) ? 'Bash' : given;
  const args = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if ((name === 'Bash' || name === 'WebFetch' || name.startsWith('mcp__')) && BOARD().test(JSON.stringify(args))) return deny(BOARD_REASON);
  if (name === 'Bash') return bashDecision(String(args.command || ''), cwd);
  // The pairing key lets its holder act as the user on the board. Where a tool looks is checked, not the text it
  // writes: a file about the key may say its name.
  const { content: _content, new_string: _new, old_string: _old, edits: _edits, ...where } = args;
  const places = JSON.stringify(where);
  if (/\.board-key\b|\.b[\w-]*[*?[\]{]/.test(places)) return deny(BOARD_REASON);
  const target = args.file_path || args.notebook_path || args.path || args.destination;
  if (typeof target === 'string' && path.basename(realPath(path.resolve(cwd, target))) === '.board-key') return deny(BOARD_REASON);
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return fileDecision(target, cwd);
  if (name.startsWith('mcp__')) {
    if (MCP_FILE.test(name)) {
      const refused = [args.path, args.file_path, args.destination, args.source].map((file) => fileDecision(file, cwd)).find((d) => d.deny);
      if (refused) return refused;
    }
    return mcpDecision(name, args);
  }
  return allow();
}

/** Returns true when the session directory lies inside the workspace. */
export const inWorkspace = (cwd) => within(cwd || process.cwd(), workspace());
