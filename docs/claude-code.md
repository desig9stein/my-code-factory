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

This writes `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`; `--settings <file>` picks another file). It keeps every other hook and setting, replaces an entry that points at the `bin/guard.mjs` of another factory installation, copies the previous file to `settings.json.bak`, and changes nothing when the hooks are already current. Restart running Claude Code sessions afterwards. To merge by hand instead, add the printed entries next to your existing hooks; do not replace them.

- Pre-tool hook: refuses supported outward actions on unapproved factory work, direct writes to protected evidence/state, and agent access to the human approval UI.
- Post-tool hook: links transcript paths to task IDs mentioned by tool calls, then updates board data.
- Session-start hook: summarizes tasks in flight.

Keep your harness's own sandbox and permissions enabled. Shell-pattern guards cannot cover every possible program, protocol, or malicious tool. A process with unrestricted filesystem access can bypass these conventions.

The human runs the board and handles approval. Agents use `factory status <id>` and recorded CLI operations. Follow [the workflow](workflow.md), plus each project's own instructions and verification commands.
