# The recorded workflow

Use `factory help` for all commands. `factory next <id>` prints what the current stage of a task needs: the files to read first, the skills and agents to use, the instructions, the exit rule and what is still missing. The steps below are the defaults; see [Configuring the workflow](#configuring-the-workflow) for what can change. Tasks run in one of two tiers: `standard` goes through every stage below, and `trivial` (a `Tier: trivial` line in `triage.md`, for a clear change of one or two files) skips the reproduction and the plan.

1. `factory new 'app#42'` snapshots the issue and creates an isolated branch/worktree.
2. `factory advance app-42` moves to triage. Write `triage.md` in the task's data folder with `Type: bug|feature|docs|chore`, `Scope: ...`, and `Verdict: clear|unclear`. An unclear issue needs `questions.md` and becomes blocked for clarification. Add `Tier: trivial` for a clear change of at most two files (`trivialMaxFiles` in the registry): it goes straight to implement, and gates, the verifier and approval still apply. A trivial bug still needs its regression proof. If the change grows past the limit, set `Tier: standard` and advance; the task returns to reproduce and plan.
3. For bugs, record a real reproduction with `factory run app-42 reproduce --expect-fail -- <command>`. A run recorded without `--expect-fail` does not count. Manual visual reproduction uses `factory note app-42 reproduce <description>`.
4. If other registered projects use this one (see `factory graph <project>`), say under `## Consumer impact` what happens to each direct user, naming it. Write a short `plan.md` with `## Acceptance criteria` (at least one list item: an observable result the verifier can check), `## Files`, `## Tests`, `## Consumer impact`, and `## Changelog`. Use `factory advance` between stages.
5. Implement inside the worktree and commit. Run registered checks with `factory run app-42 verify` (or each configured gate name). Evidence is tied to a clean committed tree.
6. Prove regression coverage using `factory regress app-42 --tests <paths> -- <test command>`: it must fail on the base and pass on the fix. Add `--expect-output "<text>"` so the base run only counts when its output shows that text; otherwise a missing import fails the base just as well as the bug does. The command prints the end of the base log so you can check the reason. Use a recorded manual check only where a command cannot demonstrate the behavior.
7. Write `pr-body.md`, run `factory check app-42`, and obtain an independent review. The verifier runs gates with `--as verifier`, checks the claims, and records `factory verdict app-42 pass|fail --report <file>` on a clean tree. When the plan lists acceptance criteria, a passing report must have an `Acceptance criteria` section saying how each was checked.
8. Advance to ready. A human reads the diff, evidence, and draft, then approves in the board or using `factory approve app-42` in an interactive terminal. Approval covers the commit and the exact text of `pr-body.md` (or `review.md`); a push or PR is refused once either differs.
9. After authorization, push and create the PR using Git/GitHub tooling, then record its URL with `factory pr app-42 <url>`. The factory itself does not automatically publish or merge.
10. Archive finished work using the board or `factory archive app-42`. Dirty worktrees are refused. Branch deletion is an explicit CLI option.

Commands may overlap: two runs that end together get their own evidence numbers, and two commands that change one task take turns. A command that waits more than 15 seconds for another names that process and writes nothing; run it again.

The CLI writes state and evidence. Never hand-edit `state.json`, evidence records, or verifier output to manufacture a passing stage. Documents such as the plan and PR draft are editable. Hooks provide guardrails for supported agent calls; they are not an OS sandbox or proof of reviewer identity.

For PR review use `factory review 'app#123'`. The review worktree is detached. Run checks, write `review.md` beginning with `Verdict: approve|request-changes|comment`, obtain human approval of that exact draft, then post and record `factory posted <id>`. `factory refresh <id>` updates to a new PR head. Never push from a review worktree.

The board shows each task in one of five columns and moves it when its stage changes; cards cannot be dragged, because a stage changes only through `factory advance`. With the Claude Code hooks installed it also shows which tools, skills, subagents and MCP servers were used in each stage. A task with no recorded activity is unknown, not idle: another harness, or a session without the hooks, records nothing.

`factory metrics` reports, per implemented task, whether every gate passed on its first recorded run, the failed gate runs, verifier `fail` verdicts, resets after passing checks, hours to approval and attributed tokens. It derives these from the records; a value with no data prints `n/a`.

Prefer one main builder session, small changes, and verification against observable behavior. After repeated failed corrections, preserve findings and restart with a clearer task; do not automatically discard uncommitted work.

## Starting a task and an agent from the board

"New task", and "Start task" on a GitHub issue, create the task from the board: the server runs the same intake as `factory new` or `factory review`, so the issue is fetched and the branch and worktree are created without a terminal. The command is still shown for those who prefer it.

A task's page then offers three ways to put an agent on it, each with the first message filled in ("Work on the Codeignite task <id> with the factory skill", plus the command that prints the brief):

- **Open in terminal** uses the `claude-cli://open` link of Claude Code. It opens a terminal session in the task's worktree with the message typed in; you press Enter. The link works after `claude` has been used interactively once on the machine.
- **Open in VS Code** uses the `vscode://anthropic.claude-code/open` link. It opens a new Claude Code chat in the VS Code window you last used, so open the task's worktree there first. The link cannot choose the folder.
- **Copy the prompt** is for JetBrains IDEs and any other agent, which have no such link.

The same page can also run the agent for you, described next.

## Running an agent from the board

"Run agent" on a task's page starts your coding agent in the background. `factory work <id>` does the same in a terminal and stops with Ctrl-C. Today the agent is Claude Code: the factory starts the `claude` program installed on your machine, so the session uses the login you already have. The factory never reads or stores a credential.

A run works like this:

- **One fresh session per step.** The session gets the task id, is told to run `factory next <id>`, to do only the current step, to run `factory advance <id>` and to stop. When it ends, the factory looks at the task and starts the next session. Each step so runs with a clean context on the model the Workflow page names for it, and the verifier is never the session that wrote the change.
- **It stops when the task needs you**: at human review, when the task is blocked (unclear issue, attempt limit), when a session fails, when you press "Stop the agent", after two sessions in a row that end without finishing the step, after the configured number of sessions, or when a session runs past its time limit. A task cannot be archived while an agent runs on it. The task's page says which, shows the agent's last message, and lists the commands that were refused.
- **It never approves, pushes or opens a pull request.** A run does not start at `ready` or later. Approval is yours, and creating the pull request stays a button on the board.
- **Intake needs no session.** The factory moves a new task from `intake` to `triage` by itself.

The record of the last run is `agent-run.json` in the task's data folder, and `agent.log` beside it holds what the agent said and the names of the tools it used. As in the activity record, a shell command is reduced to its program name. Token counts come from the session files Claude Code writes, as for a session you start yourself; the cost a session reports is shown as reported and is an estimate by Claude Code, not a bill.

A task whose run ended without reaching your review is listed under "Your turn" as "agent stopped", until someone works on it again. The tab title shows how many tasks wait for you, and "Notifications" on the Settings page adds a notification of the system for each task that newly needs you while the board's tab is not in front. The choice is kept in the browser; the board must be open in a tab.

Stopping the board (`factory board --stop`) ends the sessions it started. A run that was cut off that way reads "The board stopped while the agent was running"; start it again to continue from the task's current step.

### Agent settings

"Agents the board runs" on the Settings page holds the settings of this machine. They are stored under `agents` in `config.json` and are not part of the team export, because what an unattended agent may do is each person's decision.

| Setting | Default | Meaning |
|---------|---------|---------|
| What an agent may do (`permission`) | `scoped` | See the modes below. |
| Account (`account`) | `login` | `login` uses the account you logged in to Claude Code with and does not pass `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` to the session, so a key in your shell is not billed by accident. `environment` passes your environment unchanged. |
| Agents at once (`maxConcurrent`) | 2 | From 1 to 8. A further "Run agent" waits in a queue. More agents use your plan's limits faster. |
| Sessions per run (`maxSessions`) | 12 | From 1 to 40. A brake against a run that loops. |
| Minutes per session (`sessionMinutes`) | 60 | From 1 to 480. A session that runs longer is interrupted and the run stops, so a hung session does not hold its slot. Committed work stays. |
| Start on creation (`autoStart`) | off | A task created on the board gets an agent at once. |

Permission modes:

- `scoped`, "Edits and listed commands": the session may edit files in the task's worktree and its document folder, and run the factory CLI, Git without push (`status`, `diff`, `log`, `add`, `commit` and similar), `echo` and `pwd`, and the project's install and check commands. Everything else is refused, and the refusal is reported on the task. `git push` and the `gh` commands that publish are refused by name.
- `auto`, "Claude Code auto mode": Claude Code decides per command. Your version and plan must offer it.
- `own`, "My own Claude Code settings": the factory adds no rule. What your settings allow runs; what they would ask about is refused, because nobody is there to answer.

A project can have its own mode and a list of extra command prefixes for the scoped mode: "Edit" on its card, or `"agent": { "permission": "scoped", "allow": ["npm test", "npx vitest"] }` in its `repos.json` entry. A line allows every command that starts with it and may not contain brackets.

These rules limit which commands Claude Code runs. They are not an operating-system sandbox: a permitted command can still do anything your user can. Keep the sandbox of Claude Code on (see [the adapter notes](claude-code.md)) and install the guard hooks, which refuse a push or a pull request before approval whatever the mode.

A subscription login is meant for your own use of Claude Code. The factory starts your own installation on your own machine and keeps the number of agents low by default; if you raise it, your plan's usage limits and Anthropic's terms for your plan still apply. A team that wants many unattended agents should use API keys with the `environment` account.

### Other coding agents

The runner knows a coding agent only through an adapter in `lib/harnesses.mjs`: how to build the command of one session, how to read the lines it prints, which permission modes and accounts it offers, and where it writes its session file. `lib/harness-claude.mjs` is the one adapter today. A second agent is one more file with the same functions and one line in that list; the queue, the stage loop, the board and the settings do not change.

## After the pull request opens

While a task is at `pr-opened`, "Ask GitHub now" on its page asks GitHub about its pull request: the result of each check, the reviews, the comments and the comments on lines, through your `gh` login. The board never asks by itself, so it uses your GitHub allowance only when you press the button, and the page says when it last asked. What the author of the pull request wrote is left out. The answer is kept in `pr-feedback.json` in the task's data folder.

- A failed check, or something a reviewer wrote since you last sent feedback, puts the task under "Your turn" with the checks and the words listed. Nothing else happens by itself.
- "Send to the agent" opens the text that would be sent, made from the failed checks and the feedback. Change it to say what you want fixed, then confirm. The task returns to `implement` with your text in the brief. Text written on GitHub reaches an agent only this way.
- The fix goes through the checks, the verifier and your approval like any change. "Create the pull request" then pushes the approved commit to the same branch and records the update.
- Checks of the commit before the fix are not shown as failures of the new one, and feedback you already sent is not shown as new again.
- A merged pull request reads "merged" and offers Archive. A closed one says so.
- When GitHub cannot be asked, the last answer stays on screen with the reason.

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
