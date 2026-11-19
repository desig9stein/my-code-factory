# The recorded workflow

Use `factory help` for all commands. This version retains the original stage engine; proportional shortcuts for trivial tasks are future work.

1. `factory new 'app#42'` snapshots the issue and creates an isolated branch/worktree.
2. `factory advance app-42` moves to triage. Write `triage.md` in the task's data folder with `Type: bug|feature|docs|chore`, `Scope: ...`, and `Verdict: clear|unclear`. An unclear issue needs `questions.md` and becomes blocked for clarification.
3. For bugs, record a real reproduction with `factory run app-42 reproduce --expect-fail -- <command>`. Manual visual reproduction uses `factory note app-42 reproduce <description>`.
4. Write a short `plan.md` with `## Files`, `## Tests`, `## Consumer impact`, and `## Changelog`. Use `factory advance` between stages.
5. Implement inside the worktree and commit. Run registered checks with `factory run app-42 verify` (or each configured gate name). Evidence is tied to a clean committed tree.
6. Prove regression coverage using `factory regress app-42 --tests <paths> -- <test command>`: it must fail on the base and pass on the fix. Use a recorded manual check only where a command cannot demonstrate the behavior.
7. Write `pr-body.md`, run `factory check app-42`, and obtain an independent review. The verifier runs gates with `--as verifier`, checks the claims, and records `factory verdict app-42 pass|fail --report <file>`.
8. Advance to ready. A human reads the diff, evidence, and draft, then approves in the board or using `factory approve app-42` in an interactive terminal. A changed commit/draft needs renewed approval.
9. After authorization, push and create the PR using Git/GitHub tooling, then record its URL with `factory pr app-42 <url>`. The factory itself does not automatically publish or merge.
10. Archive finished work using the board or `factory archive app-42`. Dirty worktrees are refused. Branch deletion is an explicit CLI option.

The CLI writes state and evidence. Never hand-edit `state.json`, evidence records, or verifier output to manufacture a passing stage. Documents such as the plan and PR draft are editable. Hooks provide guardrails for supported agent calls; they are not an OS sandbox or proof of reviewer identity.

For PR review use `factory review 'app#123'`. The review worktree is detached. Run checks, write `review.md` beginning with `Verdict: approve|request-changes|comment`, obtain human approval of that exact draft, then post and record `factory posted <id>`. `factory refresh <id>` updates to a new PR head. Never push from a review worktree.

Prefer one main builder session, small changes, and verification against observable behavior. After repeated failed corrections, preserve findings and restart with a clearer task; do not automatically discard uncommitted work.
