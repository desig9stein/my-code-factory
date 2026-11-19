// Decides whether a Claude Code tool call may run against factory-owned work.
import path from 'node:path';
import { issuesDir, within, workspace } from './paths.mjs';
import { getRepo, loadRegistry } from './registry.mjs';
import { tryGit } from './sh.mjs';
import { boardPort } from './port.mjs';
import { approvalIntact } from './stages.mjs';
import { listStates } from './state.mjs';

const PUSH = /\bgit\b[^|;&\n]*\bpush\b/;
const GH_OUT = /\bgh\s+(pr\s+(create|comment|review|merge|close|edit)|issue\s+comment)\b|\bgh\s+api\b[^|;&\n]*\/pulls\/\d+\/(reviews|comments)/;
const APPROVE = /factory(\.mjs)?["']?\s+approve\b/;
const SERVE = /factory(\.mjs)?["']?\s+serve\b|\bFACTORY_(PORT|ROOT|WORKSPACE)\b/;
const PROTECTED = /issues\/[^/\s'"]+\/(state\.json|evidence\b|verify\.md)/;
const WRITES = />|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\btruncate\b|\bdd\b|\bnode\s+-e|\bpython3?\b|\bperl\b|\bln\b|\bchmod\b/;
const MCP_OUT = /^mcp__.*(push|create_pull_request|pull_request_create|add_issue_comment|issues_add_comment|create_or_update_file|review|comment|merge_pull_request)/i;

const BOARD = () => new RegExp(`(127\\.0\\.0\\.1|localhost|\\[::1\\]|0\\.0\\.0\\.0):${boardPort()}\\b`);
const BOARD_REASON = 'The factory board is where the user approves. Agents do not open it or call its API. Read state with "factory status <id>".';

const allow = () => ({ deny: false });
const deny = (reason) => ({ deny: true, reason });

// Collects the directories a shell command may run in: cwd, "cd <dir>" and "-C <dir>".
function commandDirs(cmd, cwd) {
  const dirs = [cwd];
  for (const m of cmd.matchAll(/(?:\bcd|-C)\s+("([^"]+)"|'([^']+)'|(\S+))/g)) {
    dirs.push(path.resolve(cwd, m[2] || m[3] || m[4]));
  }
  return dirs;
}

// Work may go out once approved at HEAD with the approved PR body or review draft unchanged.
const approvedAtHead = approvalIntact;

function refusal(s, what) {
  return deny(
    `Factory ${s.kind === 'review' ? 'review' : 'issue'} ${s.id} is at stage "${s.stage}", so ${what} is refused. It needs ${s.kind === 'review' ? "the user's approval of the unchanged draft" : "passing gates, a verifier pass and the user's approval of the unchanged pr-body.md"} at the current HEAD. Run "factory status ${s.id}" to see what is missing. Do not work around this block.`,
  );
}

function bashDecision(cmd, cwd) {
  if (APPROVE.test(cmd)) {
    return deny('Approval belongs to the user. Ask them to run "factory approve <id>" in their own terminal.');
  }
  if (SERVE.test(cmd)) return deny(BOARD_REASON);
  if (PROTECTED.test(cmd) && WRITES.test(cmd.replace(/\d?>\s*(\/dev\/null|&\d)/g, ''))) {
    return deny('Factory state, evidence and verify.md are written only by the factory CLI ("factory run", "factory advance", "factory verdict").');
  }
  const push = PUSH.test(cmd);
  const gh = GH_OUT.test(cmd);
  if (!push && !gh) return allow();

  const registry = loadRegistry();
  const dirs = commandDirs(cmd, cwd);
  for (const s of listStates()) {
    const repo = getRepo(s.repo, registry);
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

function fileDecision(filePath, cwd) {
  if (!filePath) return allow();
  const abs = path.resolve(cwd, filePath);
  if (!within(abs, issuesDir())) return allow();
  const rel = path.relative(issuesDir(), abs).split(path.sep).slice(1).join('/');
  if (rel === 'state.json' || rel === 'verify.md' || rel === 'evidence' || rel.startsWith('evidence/')) {
    return deny('Factory state, evidence and verify.md are written only by the factory CLI ("factory run", "factory advance", "factory verdict").');
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
  const name = input.tool_name || '';
  const args = input.tool_input || {};
  if ((name === 'Bash' || name === 'WebFetch' || name.startsWith('mcp__')) && BOARD().test(JSON.stringify(args))) return deny(BOARD_REASON);
  if (name === 'Bash') return bashDecision(String(args.command || ''), cwd);
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return fileDecision(args.file_path || args.notebook_path, cwd);
  if (name.startsWith('mcp__')) return mcpDecision(name, args);
  return allow();
}

/** Returns true when the session directory lies inside the workspace. */
export const inWorkspace = (cwd) => within(cwd || process.cwd(), workspace());
