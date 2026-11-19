# The recorded workflow

Use `factory help` for all commands. Tasks run in one of two tiers: `standard` goes through every stage below, and `trivial` skips the reproduction and the plan.

1. `factory new 'app#42'` snapshots the issue and creates an isolated branch/worktree.
2. `factory advance app-42` moves to triage. Write `triage.md` in the task's data folder with `Type: bug|feature|docs|chore`, `Scope: ...`, and `Verdict: clear|unclear`. An unclear issue needs `questions.md` and becomes blocked for clarification. Add `Tier: trivial` for a clear change of at most two files (`trivialMaxFiles` in the registry): it goes straight to implement, and gates, the verifier and approval still apply. A trivial bug still needs its regression proof. If the change grows past the limit, set `Tier: standard` and advance; the task returns to reproduce and plan.
3. For bugs, record a real reproduction with `factory run app-42 reproduce --expect-fail -- <command>`. A run recorded without `--expect-fail` does not count. Manual visual reproduction uses `factory note app-42 reproduce <description>`.
4. Write a short `plan.md` with `## Acceptance criteria` (at least one list item: an observable result the verifier can check), `## Files`, `## Tests`, `## Consumer impact`, and `## Changelog`. Use `factory advance` between stages.
5. Implement inside the worktree and commit. Run registered checks with `factory run app-42 verify` (or each configured gate name). Evidence is tied to a clean committed tree.
6. Prove regression coverage using `factory regress app-42 --tests <paths> -- <test command>`: it must fail on the base and pass on the fix. Add `--expect-output "<text>"` so the base run only counts when its output shows that text; otherwise a missing import fails the base just as well as the bug does. The command prints the end of the base log so you can check the reason. Use a recorded manual check only where a command cannot demonstrate the behavior.
7. Write `pr-body.md`, run `factory check app-42`, and obtain an independent review. The verifier runs gates with `--as verifier`, checks the claims, and records `factory verdict app-42 pass|fail --report <file>` on a clean tree. When the plan lists acceptance criteria, a passing report must have an `Acceptance criteria` section saying how each was checked.
8. Advance to ready. A human reads the diff, evidence, and draft, then approves in the board or using `factory approve app-42` in an interactive terminal. Approval covers the commit and the exact text of `pr-body.md` (or `review.md`); a push or PR is refused once either differs.
9. After authorization, push and create the PR using Git/GitHub tooling, then record its URL with `factory pr app-42 <url>`. The factory itself does not automatically publish or merge.
10. Archive finished work using the board or `factory archive app-42`. Dirty worktrees are refused. Branch deletion is an explicit CLI option.

The CLI writes state and evidence. Never hand-edit `state.json`, evidence records, or verifier output to manufacture a passing stage. Documents such as the plan and PR draft are editable. Hooks provide guardrails for supported agent calls; they are not an OS sandbox or proof of reviewer identity.

For PR review use `factory review 'app#123'`. The review worktree is detached. Run checks, write `review.md` beginning with `Verdict: approve|request-changes|comment`, obtain human approval of that exact draft, then post and record `factory posted <id>`. `factory refresh <id>` updates to a new PR head. Never push from a review worktree.

The board shows each task in one of five columns and moves it when its stage changes; cards cannot be dragged, because a stage changes only through `factory advance`. With the Claude Code hooks installed it also shows which tools, skills, subagents and MCP servers were used in each stage. A task with no recorded activity is unknown, not idle: another harness, or a session without the hooks, records nothing.

`factory metrics` reports, per implemented task, whether every gate passed on its first recorded run, the failed gate runs, verifier `fail` verdicts, resets after passing checks, hours to approval and attributed tokens. It derives these from the records; a value with no data prints `n/a`.

Prefer one main builder session, small changes, and verification against observable behavior. After repeated failed corrections, preserve findings and restart with a clearer task; do not automatically discard uncommitted work.
