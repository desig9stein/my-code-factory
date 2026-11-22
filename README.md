# Codeignite

Codeignite is a local workspace for taking GitHub issues and pull requests through implementation, recorded checks, independent verification, and human approval. A compact dark interface puts changes, evidence, drafts, and token usage in one place.

This is the first working version. It reuses the engine of the code factory it grew out of, has no runtime npm dependencies, and keeps your project data outside this repository.

## Start on a new machine

Requires Node.js 22 or newer, Git, and the GitHub CLI (`gh`) authenticated for the repositories you use. macOS and Linux are the initial targets; Windows is not yet validated. Gate commands also need each project's own tools.

```sh
git clone https://github.com/desig9stein/my-code-factory.git
cd my-code-factory
npm ci --ignore-scripts
npm run verify
npm link
codeignite setup --workspace "$HOME/projects"
codeignite board
```

The workspace directory must exist. `npm link` puts three names for the same command on your PATH: `codeignite`, the short form `cig`, and `factory`, which is what the command was called before and still works. If you prefer not to link a command globally, replace `codeignite` with `node /path/to/my-code-factory/bin/codeignite.mjs`; the board prints commands in whichever form works on your machine. The repository on GitHub is still named `my-code-factory`.

Coming from a version where the command was `factory` and the data lived in `~/.code-factory`? Everything keeps working as it is. `codeignite migrate` moves you to the new names when you choose; see [migration](docs/migration.md).

`codeignite setup` checks Node.js, Git and the GitHub CLI login, creates `~/.codeignite/config.json` and `repos.json` without overwriting existing settings, and lists every GitHub repository directly inside the workspace with a suggested install command and verification gate. It registers them after one confirmation; `--yes` skips the question. Running it again registers only what is new.

The suggestions come from each repository's lockfile and `package.json` scripts and are not run during setup. Review them on the **Projects** page of the board, where you change the base branch, install command and gates of a project, register a repository that setup found, or remove one. A project outside the workspace is registered with `codeignite add <key> <directory>`. See [project configuration](docs/projects.md).

`codeignite hooks --install` adds the optional Claude Code guard hooks to your settings and keeps your other hooks.

```sh
codeignite new 'app#42'
codeignite status app-42
codeignite review 'app#123'
codeignite help
```

The board listens on `http://127.0.0.1:4317` and answers only a browser paired with it. `codeignite board` opens your browser on a one-time link that pairs it; the browser then stays paired, also across restarts. Opening the address in a browser that is not paired shows how to pair and nothing else. With `--no-open`, the command prints the link to open yourself. `npm start` runs it in the foreground. `codeignite board` starts it in the background; `codeignite board --stop` stops that instance. `CODEIGNITE_PORT` selects another port. The server tells the page when task data changes, and the page also checks every ten seconds; open forms and explanations are preserved until you finish interacting.

## Included

- A live board: five columns grouped by what is happening (Understand, Build, Check, Your turn, Ship), with a marker on tasks an agent acted on in the last minute. A list view keeps the queue grouped by what needs you.
- Agent activity per stage: which tools, skills, subagents and MCP servers were used, with counts. Only names are stored.
- A workspace map for people who do not know the repositories: what each project is, what it depends on, who uses it, and what a change in it reaches, in order. Tasks show which downstream projects their plan names.
- Project list, stage history, and a metrics page.
- A task overview that says what the stage needs next, with acceptance criteria, checks, change size, and the text an approval covers.
- Committed diffs by file with added and removed lines marked, evidence runs with the end of each log inline, task briefs, and review drafts.
- Backend-checked approval bound to the displayed commit/draft, plus archive with dirty-worktree protection. These buttons do not publish or merge.
- A GitHub issues view: open issues assigned to you across the registered projects, with a saved filter (assigned, created, mentioning, involving, another login, anyone; state; label) and a per-project filter.
- Project editing on the Projects page: base branch, install command and verification gates, checked before they are saved.
- A Settings page: the setup checklist (required tools, registered projects, projects without a gate, hook status) and the settings of the agents the board runs. The navigation marks it when a check fails.
- A task page in three tabs that follow the step: Review (the text and the change an approval covers), Proof (checks, recorded runs with failures first, the verifier report) and Details (issue, triage, plan, agent activity, usage, archive).
- After the pull request opens, "Ask GitHub now" on the task fetches its checks and reviews: failed checks and what reviewers wrote put the task back in your hands, and "Send to the agent" returns it with the text you confirm. The fix comes back for your approval before the pull request is updated.
- First steps for a new user: a "Get started" panel on the Work queue lists six steps (tools, guard hooks, a project with a check, a first task, a first agent run, a first approval), ticks each from what really happened on the machine and offers the button for the next one. Explanations are shown on every page until the first approval, unless the user sets the switch.
- Notifications: the tab title counts the tasks that wait for you, and Settings can switch on a notification of the system when a task reaches your review, has questions, or its agent stopped. It is shown while the board is open in a tab that is not in front, and nothing leaves the machine.
- A "? Explain" switch in the header. Off, every page shows status and actions only; on, it adds the sentences that explain them. The choice is kept in the browser.
- A Workflow page: per-stage instructions, skills and agents, and per-type checks, for all projects or one. It lists the skills, agents and instruction files a repository already has and proposes where to use them.
- `codeignite next <id>`: the brief an agent follows for the current stage.
- Brakes: a limit on failed attempts before a task waits for you, and "Send back" at human review with a lesson that later briefs carry.
- Suggestions for recommended third-party skills (not bundled) when they are installed.
- A Daily report: what Codeignite, your commits and your pull requests recorded for a day, as a short summary. Claude Code can rewrite it in plain English on request. `codeignite report [today|yesterday|<date>] [--plain]` prints the same.
- `codeignite export` and `codeignite setup --from <file>`: one file that gives a team the same projects, gates and workflow.
- Agents run from the board: "Run agent" on a task starts Claude Code in the background with your own login, one fresh session per step, and stops when the task needs you. You choose what an agent may do, how many run at once and whether new tasks start one. `codeignite work <id>` does the same in a terminal.
- Tasks start from the board: it fetches the issue and creates the branch and worktree. A task's page opens a Claude Code session on it in the terminal or VS Code with the first message filled in, or copies the prompt for other editors.
- Full-task and individual linked-session token counts: uncached input, cache write, cache read, output, and totals.
- Electricity and carbon scenarios with appliance runtime and driving equivalents, editable assumptions, formulas, source attribution, and explicit exclusions.
- Issue/review workflows, worktrees, reproducibility checks, evidence integrity checks, and configurable project gates.
- A `trivial` tier that skips reproduce and plan for changes of one or two files, and acceptance criteria the verifier must answer for everything else.
- `codeignite metrics`: first-pass gate rate, failed runs, verifier fails, resets and time to approval, derived from the records.
- An example sandbox and permission file for Claude Code in `docs/examples`.
- Optional Claude Code hook configuration generated by `codeignite hooks`, merged into your settings by `codeignite hooks --install`.

The CLI can be used by any coding harness. Running an agent from the board, automatic transcript attribution and hook integration currently support Claude Code only; the runner reaches it through one adapter file, so another agent can be added without changing the rest. A missing or unsupported usage source is shown as unavailable, not zero.

## Data and portability

```text
my-code-factory/             tracked, reusable source
  bin/                      CLI and hook entry points
  lib/                      workflow, evidence, tokens, HTTP server
  web/                      buildless dark interface and scenario math
  test/                     isolated integration and unit tests
  docs/                     workflow, adapters, migration, calculations
~/.codeignite/              local, not published
  config.json               workspace location
  repos.json                project registry and commands
  issues/                   task state, documents, evidence, session links
  worktrees/                isolated Git worktrees
```

On another machine, clone Codeignite and your projects, then run `codeignite setup`. You can reuse reviewed project policies from `repos.json`, adjusting paths to the new workspace. Do not copy active worktrees or transcript paths blindly: those are machine-local resources.

For an existing Codeignite, point the new code at its data with `CODEIGNITE_ROOT` and `CODEIGNITE_WORKSPACE`. See [migration](docs/migration.md). The original implementation need not be deleted.

## Honest usage reporting

Token counts are recorded values with limited attribution coverage. Energy and carbon are **illustrative scenarios**, not provider measurements. Default energy coefficients are uncalibrated demonstration inputs, and the default grid intensity is an assumption. The interface shows these facts beside the result and expands to exact arithmetic.

See [calculation method](docs/calculations.md) for units, assumptions, sources, and exclusions. We make no measured energy-saving or productivity claims.

## Working with the Codeignite

Read the [workflow](docs/workflow.md), [project configuration](docs/projects.md), and [Claude Code adapter](docs/claude-code.md). Start with one builder and one independent verification pass. Codeignite records checks; it does not provide an OS sandbox or prove that two actor labels represent independent people or models.

The local board has host and request-token checks and answers only a browser paired from your terminal, so another program on the machine cannot load the page and approve as you. The pairing key is `.board-key` in the data folder, readable by your user only; sessions the board starts are refused that file, and the guard hooks refuse it to other agent sessions. Hooks are workflow guardrails, not a security boundary against a process with filesystem access. Keep the board local and configure your coding harness's own sandbox and permissions.

## Development

```sh
npm run verify
```

This checks JavaScript syntax and runs isolated tests with temporary repositories. CI runs the same command on Node 22 and 24 on Linux and macOS. There is no frontend build step. The server embeds `web/` assets into the page; static export uses `codeignite board --static --no-open`.

Next candidates: adapters for other coding agents, additional usage providers, pull requests in the GitHub view, and rework measured after merge. They are not implemented in this release.
