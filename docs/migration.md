# Move the source, retain the active workspace

Clone this repository separately from the original factory. The new code can read the original registry, states, evidence, and session links in place:

```sh
export FACTORY_ROOT="/path/to/existing/workspace/factory"
export FACTORY_WORKSPACE="/path/to/existing/workspace"
export FACTORY_PORT=4318
node /path/to/my-code-factory/bin/factory.mjs status
node /path/to/my-code-factory/bin/factory.mjs board
```

Use a different port while the old board is running. The new board uses a port-specific PID file. Keep these environment settings in your own shell profile or launcher, never in the public source repository. Existing hook settings continue pointing at the original implementation until you explicitly update them.

The new code refreshes token caches with session subtotals and data availability metadata; old readers ignore the additional fields. Worktree paths, stage rules, and task IDs remain compatible. Use only one CLI writer at a time: this release does not implement process-wide locking.

Do not physically move active worktrees. Git records their locations, task states contain absolute paths, and transcript links refer to files on the current machine. Finish/archive tasks first, or perform a separate deliberate Git worktree migration. To revert the interface, stop the new board and continue using the old one.

For a fresh machine, install the source, clone your project repositories, initialize a new data directory, and add projects. Copy reusable verification commands and project policies, not credentials or session transcripts. Private evidence/history can be backed up separately if required; it does not belong in this public repository.
