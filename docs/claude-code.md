# Optional Claude Code adapter

The engine is a CLI usable from any harness. The included hook adapter understands Claude Code's tool payloads and JSONL usage records. Other harnesses can run the CLI, but their hooks and token formats are not implemented here.

Run this from the Codeignite installation, with the same `CODEIGNITE_ROOT` and `CODEIGNITE_WORKSPACE` overrides used by your board:

```sh
codeignite hooks
```

It prints a JSON `hooks` object with fully quoted local paths for `PreToolUse`, `PostToolUse`, and `SessionStart`. Nothing is installed by this command, and generated machine paths should stay out of Git.

To merge the entries for you:

```sh
codeignite hooks --install
```

This writes `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`; `--settings <file>` picks another file). It keeps every other hook and setting, replaces an entry that points at the `bin/guard.mjs` of another Codeignite installation, copies the previous file to `settings.json.bak`, and changes nothing when the hooks are already current. It also writes `skills/factory/SKILL.md` and `agents/factory-verifier.md` next to the settings file, with the same backup rule. Both only tell the agent to run `codeignite next <id>` and follow the brief, so what an agent does per stage is edited on the Workflow page, not in these files. Restart running Claude Code sessions afterwards. To merge by hand instead, add the printed entries next to your existing hooks; do not replace them.

- Pre-tool hook: refuses supported outward actions on unapproved codeignite work, direct writes to protected evidence/state, and agent access to the human approval UI. For each allowed call that runs inside a task worktree or names a task, it appends one line to that task's `activity.jsonl`: time, stage, and the tool, skill, subagent or MCP server name. A shell command is reduced to its program name (`npm`, `git`); arguments, file paths and contents are not stored.
- Post-tool hook: links transcript paths to the tasks a call concerns (it names the task, or runs inside its worktree). It refreshes the static board file for those calls at most twice a minute; the board server builds its own data on request.
- Session-start hook: summarizes tasks in flight.

## Skills and the verifier agent

`codeignite hooks --install`, and "Install the hooks" on the board's Settings page, write one Agent Skill and one subagent next to your Claude Code settings: the skill `codeignite` (`skills/codeignite/SKILL.md`) for the builder, and the read-only agent `codeignite-verifier` (`agents/codeignite-verifier.md`). Both are generated, so they always name the command of this installation, and both only tell the agent to run `codeignite next <id>` and follow the brief. Sessions run in your project worktrees, not in this repository, which is why they are installed for your user.

A workflow saved before the rename may still name the agent `factory-verifier`; it is read as `codeignite-verifier`.

Other harnesses that read the Agent Skills format can use the same skill folder.

## Sessions the board starts

"Run agent" and `codeignite work <id>` start `claude -p` in the task's worktree, one session per step, with `--output-format stream-json`, the step's model and the permission mode you chose. See [Running an agent from the board](workflow.md#running-an-agent-from-the-board). The hooks, the Codeignite skill and the verifier agent above apply to these sessions as to any other, because they are ordinary Claude Code sessions of your user. Install the hooks before you let agents run unattended: they are what refuses a push before approval in every mode.

`CODEIGNITE_CLAUDE_BIN` names another program to start instead of `claude`, for an unusual installation.

## Sandbox and permissions

[`examples/claude-settings.example.json`](examples/claude-settings.example.json) is a starting point for a project's `.claude/settings.json`: the OS sandbox with a short network allowlist and no reads of `~/.ssh` or `~/.aws`, deny rules for force pushes, publishing and `rm -rf`, and a prompt before any push. Merge it with your own settings and add the hosts your project needs. Permission rules match command text and are not a security boundary on their own; the sandbox is what limits a command that slips past them. Setting names follow the Claude Code documentation at the time of writing, so check them against your version.

Keep your harness's own sandbox and permissions enabled. Shell-pattern guards cannot cover every possible program, protocol, or malicious tool. A process with unrestricted filesystem access can bypass these conventions.

The board answers only a browser that `codeignite board` paired from the user's own terminal. An agent session that runs `codeignite board` gets the plain address, which shows nothing without the pairing. The pairing key, the pairing calls and commands that hide that the caller is an agent are refused by the pre-tool hook, and sessions the board starts carry a rule that refuses reading the key. These are rules about commands, like the rest of the guard: a process outside any harness that reads your files can still read the key, so keep the operating-system sandbox on for unattended agents.

The human runs the board and handles approval. Agents use `codeignite status <id>` and recorded CLI operations. Follow [the workflow](workflow.md), plus each project's own instructions and verification commands.
