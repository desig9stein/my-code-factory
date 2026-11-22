# Project configuration

## Setup

`codeignite setup --workspace <directory>` checks the required tools, creates a private registry in the data directory, and registers every GitHub repository directly inside the workspace. It asks once before registering; `--yes` skips the question, and without a terminal and without `--yes` it only prints what it found. Repositories that are already registered are skipped, so it is safe to run again.

Each repository gets these defaults:

| Field | Default |
|-------|---------|
| key | The folder name. |
| base branch | `origin/HEAD`, or the current branch when `origin/HEAD` is unset. |
| install | `yarn install --frozen-lockfile` for a `yarn.lock`, `pnpm install --frozen-lockfile` for a `pnpm-lock.yaml`, `npm ci` for a `package-lock.json`, otherwise empty. |
| gate `verify` | `npm run verify` when the script exists; otherwise the existing ones of `lint` and `test` joined with `&&`; otherwise `npm run build`; otherwise no gate. |

The defaults are read from files, not run. A placeholder `test` script, a suite that needs a browser, or a repository whose `package.json` is in a subfolder needs a gate you write yourself.

`codeignite init --workspace <directory>` only creates the registry. `codeignite add <key> <directory>` registers one repository, inside or outside the workspace, with the same defaults; `--verify`, `--install`, `--base` and `--remote owner/repo` override them. Origin must resolve to GitHub, or be supplied with `--remote`.

## Editing in the board

The setup checklist and the agent settings of the machine are on the Settings page. The Projects page of `codeignite board` edits a registered project: base branch, install command, gates, and what an agent the board runs may do in it. It also registers the repositories setup would find, and removes a project.

- The base branch must exist as `origin/<branch>` in the local repository. Run `git fetch origin <branch>` first when it does not. A base branch other than `origin/HEAD` is stored with `allowBaseMismatch`, so `codeignite doctor` does not report it.
- A gate name uses lowercase letters, digits and hyphens, is unique in the project, and is not `install`, `reproduce` or `regress`.
- A command is one line of at most 500 characters. Join steps with `&&`, or move them into a package script. A project has at most 10 gates.
- Changing a gate's command makes its earlier runs `stale` on tasks in flight. Run the gate again with `codeignite run <id> <gate>`.
- Removing a project is refused while one of its tasks is in flight. The repository folder and the recorded task history stay.
- "Add a project by its folder" registers a repository anywhere on the machine: type its folder (`~` works), check the suggested commands, and save. The folder must be the root of a cloned Git repository with a GitHub origin. A project outside the workspace is stored with its full path. On a teammate's machine an imported setup looks for it in their workspace first; when it is not there, its shared settings wait and apply when they add it from wherever they keep it.
- "Agents the board runs" in the project dialog sets the project's own permission mode and extra allowed commands. They are stored under `agent` in the entry, stay on this machine, and are described in [Running an agent from the board](workflow.md#agent-settings).
- "For each task" in the project dialog sets a setup and a teardown command; see [Setup and teardown for each task](#setup-and-teardown-for-each-task).
- The header shows the workspace folder.

Other fields (`remote`, `dir`, `prBody`, branch conventions) are edited in `repos.json`.

## Setup and teardown for each task

A project can name two commands that run for every task, in the task's own worktree:

```json
{ "setup": "npm ci && npm run db:create", "teardown": "npm run db:drop" }
```

- `setup` runs when the task is created, right after the worktree exists. `codeignite new` and `codeignite review` wait for it. The board does not: it creates the task at once and runs the setup beside it, the task says "setting up" meanwhile, and no agent starts on it until the setup has finished. Its run is recorded as evidence with its log. A setup that fails does not stop the task from being created: the command says so, the task's history notes it, and `codeignite run <id> setup` runs it again.
- `teardown` runs when the task is archived, before the worktree is removed. A teardown that fails is noted in the history and the task is archived all the same.
- Both, like the checks and the agent sessions on the task, are told three things: `CODEIGNITE_TASK_ID`, `CODEIGNITE_TASK_DIR` (the worktree) and `CODEIGNITE_TASK_PORT`.

The port is reserved for the task when it is created: the lowest from 41000 to 41999 that no task in flight holds, free again once the task is archived. Use it wherever a task would otherwise take a fixed port, for example `PORT=$CODEIGNITE_TASK_PORT npm run dev`, so two agents on the same project do not collide. The agent's brief names the port. Codeignite does not check that nothing else on the machine uses it. A task created before ports existed gets one the first time it is used.

What setup writes into the worktree must be ignored by Git (`node_modules`, a local database file): checks run on a clean tree, and untracked files make it dirty. Codeignite looks right after the setup and names the files it left that Git does not ignore, in the command's output and in the task's history, so this is found then and not at the checks. Files a teardown leaves behind are removed. Both commands are part of the team export.

## GitHub issues

The GitHub issues view runs `gh search issues` over the remotes of the registered projects, so it needs the GitHub CLI and a login (`gh auth login`). The filter is saved in `config.json` under `issues`:

```json
{ "issues": { "who": "assigned", "login": "", "state": "open", "label": "" } }
```

`who` is `assigned` (the default), `created`, `mentioned`, `involved`, `user` (assigned to `login`) or `anyone`. `state` is `open` or `closed`. The project select filters the loaded list in the browser. The list is kept in `cache/github-issues.json` in the data folder and shown from there, also after the board restarts. GitHub is asked again only when you press Refresh, change the filter, or add or remove a project; the page says how old the list is. Which issues are already tasks is worked out on this machine each time, so that part is always current. GitHub returns at most the 200 most recently updated issues per search. Pull requests are not listed.

## `repos.json`

Example `repos.json`:

```json
{
  "defaults": {
    "branchPattern": "factory/{type}-{n}-{slug}",
    "maxCommits": 3,
    "conventionalCommits": true,
    "forbidAiAttribution": false,
    "testable": true
  },
  "repos": {
    "app": {
      "dir": "app",
      "remote": "example/app",
      "baseBranch": "main",
      "install": "npm ci",
      "gates": [{ "name": "verify", "cmd": "npm run verify" }],
      "prBody": { "requiredSections": ["Summary", "Validation"] }
    }
  }
}
```

Paths resolve relative to the configured workspace; absolute project paths also work. Project entries override defaults. Gate commands run inside the task worktree; a gate can set `cwd` for a subdirectory. Commands are trusted local shell commands, so review imported configuration before running it.

Each recorded command stops after 30 minutes and is recorded as failed. Set `timeoutMinutes` on a project or on one gate to change that (`0` disables the limit). `trivialMaxFiles` (default 2) is the number of changed files the trivial tier allows. A gate's `cwd` and the `--cwd` option must stay inside the task worktree.

Commit scope checks and maximum commit count are configurable. The original personal AI-attribution restriction is opt-in via `forbidAiAttribution`, not a universal Codeignite policy. Optional metadata such as `notes`, `playbooks`, `consumers`, `prTemplate`, and `changelog` can guide your coding harness; the CLI does not automatically execute Markdown guidance.

## Relationships between projects

Three optional fields describe a project to people who do not know it, and place it on the board's map:

```json
"webcomponents": {
  "description": "Framework-neutral web components.",
  "owns": "a component misbehaves in React, Blazor or plain web components.",
  "dependsOn": [{ "project": "theming", "label": "uses styles" }]
}
```

- `description`: one line on what the project is.
- `owns`: completes the sentence "change here when…"; the new-task dialog shows it so a newcomer can find where a change belongs.
- `dependsOn`: the registered projects this one builds on. An entry is a project key, or `{ "project", "label" }` to say what kind of link it is.

`codeignite graph` prints the relationships; `codeignite graph <key>` prints what a project depends on, who uses it, and every project a change in it reaches, nearest first. A link to an unknown project or one that closes a cycle is reported and left out.

`codeignite doctor` reads the `package.json` files of each project (its root, its direct folders, and folders under `packages/`, `projects/` and `libs/`) and suggests links it finds there. Suggestions never change the registry and do not fail the check. Links that npm manifests cannot show, such as generated wrappers or NuGet packages, must be declared by hand. Where a manifest does show a link, the map also displays the pinned range and the version the upstream project is at; it does not judge whether the pin is out of date.

For a task, the board and `codeignite status` list the projects its repository reaches and whether the plan's `## Consumer impact` names each direct user, by project key or repository name. This is a reminder, not a gate: a task advances without it.

Run `codeignite doctor` to check configuration drift against the local repositories. The board shows projects without a gate in its setup checklist. Configure at least one meaningful verification gate before using a project for implementation work.
