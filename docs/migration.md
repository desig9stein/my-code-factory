# Moving to the name Codeignite

The command was called `factory`, its settings `FACTORY_ROOT`, `FACTORY_WORKSPACE` and `FACTORY_PORT`, its data folder `~/.code-factory`, and its skill and agent `factory` and `factory-verifier`. They are now `codeignite` (short: `cig`), `CODEIGNITE_ROOT`, `CODEIGNITE_WORKSPACE`, `CODEIGNITE_PORT`, `~/.codeignite`, `codeignite` and `codeignite-verifier`.

Nothing breaks when you update:

- `factory` still starts the same program, and says the new name once when a person runs it in a terminal.
- A `FACTORY_*` variable is read when its `CODEIGNITE_*` twin is not set.
- `~/.code-factory` is used for as long as `~/.codeignite` does not exist.
- Hooks and skills installed earlier keep working: the files they point at still exist.
- A configuration file exported earlier (`factoryConfig`) imports as before, and a saved workflow that names `factory-verifier` means `codeignite-verifier`.
- New installs use the branch prefix `codeignite/`; an existing registry keeps the pattern it has.

To move over, stop the board and run this in your own terminal:

```sh
codeignite board --stop
codeignite migrate
```

It says what it will do and asks first (`--yes` skips the question). It then:

1. moves `~/.code-factory` to `~/.codeignite`, after writing the workspace as a full path so it still means the same folder;
2. updates the worktree folder recorded in each task and runs `git worktree repair` in each project, so Git finds the moved worktrees;
3. installs the hooks under the new variable names and the new folder, writes the `codeignite` skill and the `codeignite-verifier` agent, and removes the two files under the old names when they are the ones Codeignite wrote. Your other hooks, skills and settings stay, and replaced files are kept as `.bak`.

It refuses while an agent runs on a task or the board is up, when both folders exist, and inside an agent session. When the data folder is set by a variable it is not moved; rename the variable in your shell profile when convenient. Sessions that worked in the old worktree folders stay linked to their tasks for token counts, but "last activity" starts fresh for them, because Claude Code files a session under the folder it ran in. Run `npm link` again in the repository to get the `codeignite` and `cig` commands.

# Move the source, retain the active workspace

Clone this repository separately from the original installation. The new code can read the original registry, states, evidence, and session links in place:

```sh
export CODEIGNITE_ROOT="/path/to/existing/workspace/factory"
export CODEIGNITE_WORKSPACE="/path/to/existing/workspace"
export CODEIGNITE_PORT=4318
node /path/to/my-code-factory/bin/codeignite.mjs status
node /path/to/my-code-factory/bin/codeignite.mjs board
```

Use a different port while the old board is running. The new board uses a port-specific PID file. Keep these environment settings in your own shell profile or launcher, never in the public source repository. Existing hook settings continue pointing at the original implementation until you explicitly update them.

The new code refreshes token caches with session subtotals and data availability metadata; old readers ignore the additional fields. Worktree paths and task IDs remain compatible. Task state gained two optional fields: `tier` (absent means standard) and `approvedDraftSha256` on issues, the hash of the approved `pr-body.md`. An issue approved by an older version has no hash, so only its commit is checked until it is approved again. Evidence records may carry `timedOut`, `match` and `matched`; older readers ignore them. Each task folder may now hold `activity.jsonl`, written by the pre-tool hook; a task without it shows "No agent activity recorded", and older code ignores the file. A plan written before this version needs an `## Acceptance criteria` section only if the task has not yet left the plan stage. Several commands, the board and the hooks may work on one task at the same time: a command that changes a task holds a lock file (`.lock` in the task's folder, `.settings.lock` in the data folder for the registry, the workflow and `config.json`) while it reads, decides and writes. A lock left by a process that died is taken over. Task state gained `rev`, raised on every write; a state read before another writer saved is refused with "was changed by another Codeignite command", and the command is run again. A state written by an older version has no `rev` and counts as 0. Older code ignores both the field and the lock files, so do not run an older CLI beside this one on the same data. Each task folder may also hold `agent-run.json` and `agent.log`, written when Codeignite runs an agent itself; older code ignores them. `config.json` gained an optional `agents` object and a project entry in `repos.json` an optional `agent` object; without them the defaults apply, and neither is exported. A task whose `state.json` cannot be read, or whose project is no longer in `repos.json`, is listed with the reason in `codeignite status` and in a notice on the board; the other tasks keep working.

A project entry may now carry `setup` and `teardown`, task state the optional `port`, `config.json` `agents.usageCap` and `agents.dailyBudget`, and the data folder `cache/plan-usage.json` and `cache/spend.json`; older code ignores them. The data folder may now hold `cache/github-issues.json`, the kept issue list; deleting it only makes the next visit ask GitHub. A task at `pr-opened` may now hold `pr-feedback.json`, and its state the optional fields `prFeedback` and `prFeedbackSentAt`; older code ignores them. The board now needs a paired browser: a bookmark of its address shows how to pair until you run `codeignite board` once. The key is `.board-key` in the data folder; deleting it unpairs every browser.

Do not physically move active worktrees. Git records their locations, task states contain absolute paths, and transcript links refer to files on the current machine. Finish/archive tasks first, or perform a separate deliberate Git worktree migration. To revert the interface, stop the new board and continue using the old one.

For a fresh machine, install the source, clone your project repositories, initialize a new data directory, and add projects. Copy reusable verification commands and project policies, not credentials or session transcripts. Private evidence/history can be backed up separately if required; it does not belong in this public repository.
