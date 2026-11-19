# Working on Code Factory

- Runtime: Node.js 22+, ES modules, no runtime dependencies. UI is buildless HTML/CSS/JS.
- Run `npm run verify` before reporting a change complete. Tests use temporary Git repositories.
- Source lives in `bin/`, `lib/`, and `web/`; private runtime data defaults to `~/.code-factory`.
- Never commit project registries, task history, transcripts, worktrees, generated board data, credentials, or machine paths.
- Keep verification evidence tied to a clean commit. Preserve rejection of stale approvals and dirty worktree archives.
- Use real task data. Missing usage is unavailable, not zero. Energy/carbon values are uncalibrated scenarios; keep assumptions, formulas, sources, and exclusions visible.
- Preserve the restrained dark interface, explicit readable foregrounds, keyboard focus, and small-screen layout.
- Escape all external strings rendered into HTML. Keep the board bound to loopback and mutations protected by request tokens.
- Read docs/workflow.md for the task engine, docs/calculations.md for footprint semantics, and docs/migration.md before changing stored formats.
