# The recorded workflow

Use `factory help` for all commands. `factory next <id>` prints what the current stage of a task needs: the files to read first, the skills and agents to use, the instructions, the exit rule and what is still missing. The steps below are the defaults; see [Configuring the workflow](#configuring-the-workflow) for what can change.

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

## Configuring the workflow

The Workflow page of the board edits the workflow for all projects or for one project. Defaults apply first, then the "All projects" values, then the project's. Global changes are stored in `workflow.json` in the data directory, project changes under `workflow` in the project's `repos.json` entry. Only changed values are stored.

Every stage, in both the issue and the review pipeline, takes:

| Field | Meaning |
|-------|---------|
| `instructions` | The text the agent gets. Placeholders: `{id}`, `{dir}` (the task's document folder), `{worktree}`, `{types}`, `{headings}`. At most 4000 characters. |
| `use` | Skills and agents for the stage: `{ "ref", "kind": "skill" \| "agent", "types" }`. `ref` is a name Claude Code can invoke, or a Markdown path inside the project. `types` limits the entry to some task types. At most 8. |
| `model` | A model hint for the stage. |

Four issue stages also take a check setting:

| Stage | Field | Default | Meaning |
|-------|-------|---------|---------|
| `reproduce` | `skipFor` | every type but `bug` | Types that pass the stage without a reproduction. |
| `plan` | `skipFor` | none | Types that need no `plan.md`. |
| `plan` | `headings` | `Files`, `Tests`, `Consumer impact`, `Changelog` | Required `##` sections. |
| `gates` | `requireRegression` | `bug` | Types that need the regression proof. |
| `verify` | `skipFor` | none | Types that need no verifier. The PR body and commit checks still apply. |
| `verify` | `rerunGates` | `true` | Whether the verifier must re-run every gate. |

Top-level fields: `types` (the task types triage may assign, default `bug`, `feature`, `docs`, `chore`) and `readFirst` (project files listed at the top of every brief).

A skipped stage records `Skipped: <stage> is off for type <type>.` in the task history. The definition is read when a task advances, so a change applies to tasks in flight from their next stage on.

Fixed, whatever the configuration says: the exit rules of `intake`, `triage`, `implement`, `ready`, `approved` and the final stage, the evidence chain check, the clean-tree rule, the PR body and commit checks, and approval by the user bound to the commit and draft. Stages cannot be reordered or added. Saving rejects an unknown stage, a field the stage does not have, and a type that does not exist, and refuses to switch the verifier off for a type that still requires the regression proof.

## Reusing a repository's own skills and agents

`factory assets <project>` and the Workflow page list what a repository already carries:

- contributor skills in `.claude/skills`, `.agents/skills`, `.github/skills`
- agents in `.claude/agents`, `.agents/agents`, `.github/agents`
- product skills in a top-level `skills/` folder, listed and never proposed
- `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, `.github/instructions/*.md`
- the PR template

Copies with the same name are listed once, preferring `.claude/`, and flagged when their text differs. An asset under `.claude/` is used by name. Any other is used by path, and the brief says "Read and follow `<path>`". Nothing is copied.

Proposals are derived from asset names and are applied only when you accept them: a stage for an agent or skill (`implement` for an implementer, `triage` for an orchestrator, review `draft` and `verify` for a review skill, `gates` for a verify skill, `plan` for a changelog agent), `AGENTS.md` and `CLAUDE.md` as files to read first, the PR template headings as required PR sections, and a gate for each check script the instruction files name. The name matching is a heuristic; dismiss what does not fit. `factory doctor` reports a saved reference whose file is gone.

## Sharing the setup with a team

`factory export factory.config.json` (or "Export for the team" on the Projects page) writes projects, gates, PR rules, defaults and the workflow into one file. It holds no paths, task data, issue filter or dismissed proposals. Commit it to a team repository or send it.

A teammate clones the projects and runs:

```sh
factory setup --workspace "$HOME/projects" --from factory.config.json
factory hooks --install
```

`factory import <file>` applies a newer file later. Import finds each project's checkout by its GitHub remote, so folder names may differ. A project that is not cloned is listed with its `git clone` command and skipped. Before anything is written, import prints every install and gate command the file registers, because those commands later run in a shell on that machine; it asks once in a terminal and needs `--yes` without one. Local-only state is kept.
