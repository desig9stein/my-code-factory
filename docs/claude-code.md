# Optional Claude Code adapter

The engine is a CLI usable from any harness. The included hook adapter understands Claude Code's tool payloads and JSONL usage records. Other harnesses can run the CLI, but their hooks and token formats are not implemented here.

Run this from the factory installation, with the same `FACTORY_ROOT` and `FACTORY_WORKSPACE` overrides used by your board:

```sh
factory hooks
```

It prints a JSON `hooks` object with fully quoted local paths for `PreToolUse`, `PostToolUse`, and `SessionStart`. Merge these entries into your existing Claude Code settings. Do not replace other hooks or settings. Nothing is installed automatically, and generated machine paths should stay out of Git.

- Pre-tool hook: refuses supported outward actions on unapproved factory work, direct writes to protected evidence/state, and agent access to the human approval UI.
- Post-tool hook: links transcript paths to task IDs mentioned by tool calls. It rebuilds the static board file only for those calls; the board server builds its data on request.
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
