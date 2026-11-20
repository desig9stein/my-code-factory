# Optional Claude Code adapter

The engine is a CLI usable from any harness. The included hook adapter understands Claude Code's tool payloads and JSONL usage records. Other harnesses can run the CLI, but their hooks and token formats are not implemented here.

Run this from the factory installation, with the same `FACTORY_ROOT` and `FACTORY_WORKSPACE` overrides used by your board:

```sh
factory hooks
```

It prints a JSON `hooks` object with fully quoted local paths for `PreToolUse`, `PostToolUse`, and `SessionStart`. Nothing is installed by this command, and generated machine paths should stay out of Git.

To merge the entries for you:

```sh
factory hooks --install
```

This writes `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`; `--settings <file>` picks another file). It keeps every other hook and setting, replaces an entry that points at the `bin/guard.mjs` of another factory installation, copies the previous file to `settings.json.bak`, and changes nothing when the hooks are already current. It also writes `skills/factory/SKILL.md` and `agents/factory-verifier.md` next to the settings file, with the same backup rule. Both only tell the agent to run `factory next <id>` and follow the brief, so what an agent does per stage is edited on the Workflow page, not in these files. Restart running Claude Code sessions afterwards. To merge by hand instead, add the printed entries next to your existing hooks; do not replace them.

- Pre-tool hook: refuses supported outward actions on unapproved factory work, direct writes to protected evidence/state, and agent access to the human approval UI. For each allowed call that runs inside a task worktree or names a task, it appends one line to that task's `activity.jsonl`: time, stage, and the tool, skill, subagent or MCP server name. A shell command is reduced to its program name (`npm`, `git`); arguments, file paths and contents are not stored.
- Post-tool hook: links transcript paths to the tasks a call concerns (it names the task, or runs inside its worktree). It refreshes the static board file for those calls at most twice a minute; the board server builds its own data on request.
- Session-start hook: summarizes tasks in flight.

## Skills and the verifier agent

The repository ships two Agent Skills in `.agents/skills/` (`factory` for the builder, `factory-verify` for the verifier) and a read-only subagent in `.claude/agents/factory-verifier.md`. Claude Code reads skills from `.claude/skills/` in a project or `~/.claude/skills/` for every project, and agents from `.claude/agents/` or `~/.claude/agents/`. Sessions run in your project worktrees, not in this repository, so install them for your user:

```sh
mkdir -p ~/.claude/skills ~/.claude/agents
cp -R .agents/skills/factory .agents/skills/factory-verify ~/.claude/skills/
cp .claude/agents/factory-verifier.md ~/.claude/agents/
```

Other harnesses that read the Agent Skills format can use the same two folders.

## Sandbox and permissions

[`examples/claude-settings.example.json`](examples/claude-settings.example.json) is a starting point for a project's `.claude/settings.json`: the OS sandbox with a short network allowlist and no reads of `~/.ssh` or `~/.aws`, deny rules for force pushes, publishing and `rm -rf`, and a prompt before any push. Merge it with your own settings and add the hosts your project needs. Permission rules match command text and are not a security boundary on their own; the sandbox is what limits a command that slips past them. Setting names follow the Claude Code documentation at the time of writing, so check them against your version.

Keep your harness's own sandbox and permissions enabled. Shell-pattern guards cannot cover every possible program, protocol, or malicious tool. A process with unrestricted filesystem access can bypass these conventions.

The human runs the board and handles approval. Agents use `factory status <id>` and recorded CLI operations. Follow [the workflow](workflow.md), plus each project's own instructions and verification commands.
