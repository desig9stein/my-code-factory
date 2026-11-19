---
name: factory
description: Take a GitHub issue through the Code Factory stages with recorded evidence. Use when the user asks to work on a factory task (an id such as app-42), or when "factory status" lists tasks in flight.
---

# Working a factory task

The `factory` CLI owns state and evidence. You write code, documents and commits; the CLI records what was checked. `factory advance <id>` always tells you what the current stage still needs, so run it instead of guessing.

## Rules that do not bend

- Never edit `state.json`, anything under `evidence/`, or `verify.md`. Only the CLI writes them.
- Never run `factory approve`, open the board, or call its API. Approval belongs to the user.
- Never push, open a PR or comment on GitHub before the task is `approved`. After approval, push exactly the approved commit and use `pr-body.md` unchanged.
- Evidence counts only for a clean, committed tree. Commit before you run a gate.
- Do not weaken or delete a test to make a gate pass.

## Stages

1. **Intake.** `factory status <id>` shows the worktree. Work only inside it. Read `issue.md` in the task's data folder.
2. **Triage.** Write `triage.md` with `Type: bug|feature|docs|chore`, `Scope:` and `Verdict: clear|unclear`. Add `Tier: trivial` only for a clear change of one or two files; it skips reproduce and plan. If the issue is unclear, write `questions.md` and stop: the task blocks until the user answers.
3. **Reproduce (bugs).** `factory run <id> reproduce --expect-fail -- <command>`. The command must fail because of the bug.
4. **Plan.** Write `plan.md` with `## Acceptance criteria` (a list of observable results), `## Files`, `## Tests`, `## Consumer impact`, `## Changelog`. Keep it to one page.
5. **Implement.** Write the failing test first, then the fix. Commit with Conventional Commits and a scope.
6. **Gates.** `factory run <id> <gate>` for every gate. For a bug, prove the test: `factory regress <id> --tests <paths> --expect-output "<text of the failure>" -- <test command>`.
7. **Verify.** Write `pr-body.md`, run `factory check <id>`, then hand the task to an independent verifier (the `factory-verifier` agent, or the `factory-verify` skill in a fresh session). Do not record the verdict yourself.
8. **Ready.** Stop and tell the user the task waits for their approval.

## When it goes wrong

After two failed corrections of the same problem, stop. Write down what you learned, return to the last passing commit, and start again with a narrower task. Do not discard uncommitted work without asking.

If the guard refuses an action, read its reason and fix the cause. Do not look for another route to the same action.
