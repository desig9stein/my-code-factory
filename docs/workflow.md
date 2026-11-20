# The recorded workflow

Use `factory help` for all commands. `factory next <id>` prints what the current stage of a task needs: the files to read first, the skills and agents to use, the instructions, the exit rule and what is still missing. The steps below are the defaults; see [Configuring the workflow](#configuring-the-workflow) for what can change. Tasks run in one of two tiers: `standard` goes through every stage below, and `trivial` (a `Tier: trivial` line in `triage.md`, for a clear change of one or two files) skips the reproduction and the plan.

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

`factory metrics` reports, per implemented task, whether every gate passed on its first recorded run, the failed gate runs, verifier `fail` verdicts, resets after passing checks, hours to approval and attributed tokens. It derives these from the records; a value with no data prints `n/a`.

Prefer one main builder session, small changes, and verification against observable behavior. After repeated failed corrections, preserve findings and restart with a clearer task; do not automatically discard uncommitted work.

## Starting a task and an agent from the board

"New task", and "Start task" on a GitHub issue, create the task from the board: the server runs the same intake as `factory new` or `factory review`, so the issue is fetched and the branch and worktree are created without a terminal. The command is still shown for those who prefer it.

A task's page then offers three ways to put an agent on it, each with the first message filled in ("Work on the Codeignite task <id> with the factory skill", plus the command that prints the brief):

- **Open in terminal** uses the `claude-cli://open` link of Claude Code. It opens a terminal session in the task's worktree with the message typed in; you press Enter. The link works after `claude` has been used interactively once on the machine.
- **Open in VS Code** uses the `vscode://anthropic.claude-code/open` link. It opens a new Claude Code chat in the VS Code window you last used, so open the task's worktree there first. The link cannot choose the folder.
- **Copy the prompt** is for JetBrains IDEs and any other agent, which have no such link.

The board does not run an agent by itself in the background. An unattended run needs a permission mode that lets the agent edit and run commands without asking, and that choice is left to you.

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
| `plan` | `headings` | `Files`, `Test boundaries`, `Tests`, `Consumer impact`, `Changelog` | Required `##` sections. |
| `gates` | `requireRegression` | `bug` | Types that need the regression proof. |
| `verify` | `skipFor` | none | Types that need no verifier. The PR body and commit checks still apply. |
| `verify` | `rerunGates` | `true` | Whether the verifier must re-run every gate. |

Top-level fields: `types` (the task types triage may assign, default `bug`, `feature`, `docs`, `chore`) and `readFirst` (project files listed at the top of every brief). Also `maxAttempts` and `lessons`, described under Brakes.

### Brakes

The workflow has three brakes: the gates, the independent verifier, and your review. Two settings keep an agent from running past them.

**Attempt limit.** `maxAttempts` (default 5, from 1 to 20) caps failed check runs at one step and failed verifier verdicts on one task. At the limit the task is blocked with the count as its reason, `factory run` and `factory verdict` say so at once, and the brief tells the agent to stop. `factory unblock <id>` clears it and starts the count again. The brief shows the count while it grows.

**Sending a task back.** At human review, "Send back" on the board returns the task to `implement`, or a review to `draft`, with your reason in its history. In a terminal the same is `factory reject <id> --reason <text> [--lesson <text>]`. Checks and approval start again on the next version. A lesson is one line added to the project's `lessons`; every later brief of that project lists them, so what a review caught reaches the next task. Lessons are edited under "Settings for every step" on the Workflow page. Like approval, sending back is for the user only: the board checks the version it showed, and the CLI refuses to run inside an agent session.

The default instructions follow the same idea: `reproduce` asks for a pass/fail signal that fails because of the bug before any fix, `plan` names the test boundaries, `implement` works test-first at them, and `verify` has the verifier judge standards and intent separately in a fresh context and asks the PR description for evidence and merge risk.

### Recommended skills

The shared workflow suggests a third-party skill set when it fits the steps. Today that is Matt Pocock's engineering skills (MIT, https://github.com/mattpocock/skills): `diagnosing-bugs` for `reproduce`, `tdd` for `implement`, `research` for `plan`, `code-review` for `verify` and the review `draft`, `pr` for `verify`. The skills are not bundled, because the set updates itself as a Claude Code plugin; the Workflow page shows the install command until it is installed, then one suggestion per step. A skill with the same name from another source is not taken for one of these. Its `triage`, `to-spec` and `to-tickets` skills are left out because they post to the issue tracker on their own, and the `grill` skills because they need you in the conversation.

A skipped stage records `Skipped: <stage> is off for type <type>.` in the task history. The definition is read when a task advances, so a change applies to tasks in flight from their next stage on.

### Adding and removing steps

The issue pipeline can gain steps and lose two of its own. The review pipeline is fixed.

- `removed` lists built-in steps to drop: `reproduce` and `plan`. The others carry a rule the factory depends on. The verifier is switched off per task type instead, because the `verify` step also checks the PR description and the commits.
- `customStages` lists up to 6 added steps: `{ "id", "title", "about", "after", "check" }`. `after` is `triage`, `reproduce`, `plan`, `implement`, `gates`, `verify`, or an earlier added step, so a step always lies between triage and the human review. Its instructions, skills, agents, model and `skipFor` are stored under `stages.<id>` like any other step.
- `check` is `{ "kind": "none" }`, `{ "kind": "document", "file": "design.md", "headings": [] }` (the file must exist in the task's document folder with those sections) or `{ "kind": "command", "cmd": "npm run test:a11y" }`. The agent runs a command check with `factory run <id> <step>`; it must pass at HEAD on a clean tree.
- A step placed after `gates` is bound to the gated commit like `verify`: a new commit sends the task back to `gates`.
- A project either follows the shared list of steps or has its own.
- A task that sits in a step when the step is deleted continues after the last step that still exists, and its history says so.

The `ready` stage is shown as "human review" on the board and in the brief. Its key stays `ready` in stored task state.

### Models

The model of a step is picked from the models of the detected coding harness. For Claude Code these are the family aliases `fable`, `opus`, `sonnet` and `haiku`, which always point at the newest model of the family; a full model id can be typed instead. The list is built in, not fetched. The model is a line in the brief. A running session cannot change its own model, so the brief tells the agent to do the step in a subagent on that model, or to do it itself when it already runs on it.

Default models:

| Step | Model | Why |
|------|-------|-----|
| `triage` | `opus` | A wrong "clear" verdict wastes the whole task. |
| `reproduce` | `sonnet` | Writing one failing command is narrow work. |
| `plan` | `fable` | Every later step follows the plan. |
| `implement` | `opus` | Writing the change. |
| `gates` | `sonnet` | Running checks and fixing what they report. |
| `verify` | `fable` | The last automated check before you; a different and stronger model than the one that wrote the code. |
| `ready` (human review) | `sonnet` | Summarizing the task for you. |
| `approved` | `haiku` | Pushing and opening the pull request from a prepared text. |
| review `checks` | `sonnet` | Running checks and reading their output. |
| review `draft` | `opus` | Writing the code review. |
| review `ready` | `sonnet` | Summarizing the draft for you. |
| review `approved` | `haiku` | Posting the approved text. |

`intake`, `pr-opened` and `posted` have no model: the factory acts there, not an agent. A step you add has no model until you pick one. Clear the model of a step to run it on the session's model.

Fixed, whatever the configuration says: the exit rules of `intake`, `triage`, `implement`, `ready`, `approved` and the final stage, the evidence chain check, the clean-tree rule, the PR body and commit checks, and approval by the user bound to the commit and draft. Built-in stages cannot be reordered. Saving rejects an unknown stage, a field the stage does not have, and a type that does not exist, and refuses to switch the verifier off for a type that still requires the regression proof.

## Reusing a repository's own skills and agents

`factory assets <project>` and the Workflow page list what a repository already carries:

- contributor skills in `.claude/skills`, `.agents/skills`, `.github/skills`
- agents in `.claude/agents`, `.agents/agents`, `.github/agents`
- product skills in a top-level `skills/` folder, listed and never proposed
- `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, `.github/instructions/*.md`
- the PR template

Copies with the same name are listed once, preferring `.claude/`, and flagged when their text differs. An asset under `.claude/` is used by name. Any other is used by path, and the brief says "Read and follow `<path>`". Nothing is copied.

Proposals are derived from asset names and are applied only when you accept them: a stage for an agent or skill (`implement` for an implementer, `triage` for an orchestrator, review `draft` and `verify` for a review skill, `gates` for a verify skill, `plan` for a changelog agent), `AGENTS.md`, `CLAUDE.md`, `GLOSSARY.md` and `CONTEXT.md` as files to read first, the PR template headings as required PR sections, an "Evidence" PR section where the template has no testing section, and a gate for each check script the instruction files name. The name matching is a heuristic; dismiss what does not fit. `factory doctor` reports a saved reference whose file is gone.

## Sharing the setup with a team

`factory export factory.config.json` (or "Export for the team" on the Projects page) writes projects, gates, PR rules, defaults and the workflow into one file. It holds no paths, task data, issue filter or dismissed proposals. Commit it to a team repository or send it.

A teammate clones the projects and runs:

```sh
factory setup --workspace "$HOME/projects" --from factory.config.json
factory hooks --install
```

`factory import <file>` applies a newer file later. Import finds each project's checkout by its GitHub remote, so folder names may differ. A project that is not found in the workspace is not registered yet: import lists it with its `git clone` command, and keeps its shared settings on that machine. They apply as soon as the project is added, whether it is cloned into the workspace (`factory setup` finds it) or lives elsewhere and is added by its folder on the Projects page or with `factory add`. The Projects page lists the projects still waiting. Before anything is written, import prints every install and gate command the file registers, because those commands later run in a shell on that machine; it asks once in a terminal and needs `--yes` without one. Local-only state is kept.

## Daily report

`factory report [today|yesterday|YYYY-MM-DD]` and the Daily report page summarize one day from three sources:

- factory tasks whose stage changed or whose checks ran that day, including archived ones: where each task moved, its milestones (started, made ready for your review, approved, pull request opened, review posted, blocked, archived) and how many check runs passed and failed
- your commits that day in every registered project, on any branch, matched by the repository's `user.email`
- pull requests you opened or that were merged that day in the registered projects, read through the GitHub CLI

The summary is built from these records with fixed sentences, so every line states something that was recorded. When GitHub cannot be read, the summary says so and leaves pull requests out. Work outside the registered projects is not included.

`--plain`, or "Write it in plain English" on the page, sends the summary text to the Claude CLI (`claude -p`, model `sonnet`, no tools, no saved session) and prints what it writes: a few first-person bullets for a reader who does not read commit messages. The rewrite is asked to use only the given facts, but it rephrases commit titles and can get a detail wrong, so read it against the summary before you send it. `--json` prints the facts.
