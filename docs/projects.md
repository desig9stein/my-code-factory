# Project configuration

## Setup

`factory setup --workspace <directory>` checks the required tools, creates a private registry in the data directory, and registers every GitHub repository directly inside the workspace. It asks once before registering; `--yes` skips the question, and without a terminal and without `--yes` it only prints what it found. Repositories that are already registered are skipped, so it is safe to run again.

Each repository gets these defaults:

| Field | Default |
|-------|---------|
| key | The folder name. |
| base branch | `origin/HEAD`, or the current branch when `origin/HEAD` is unset. |
| install | `yarn install --frozen-lockfile` for a `yarn.lock`, `pnpm install --frozen-lockfile` for a `pnpm-lock.yaml`, `npm ci` for a `package-lock.json`, otherwise empty. |
| gate `verify` | `npm run verify` when the script exists; otherwise the existing ones of `lint` and `test` joined with `&&`; otherwise `npm run build`; otherwise no gate. |

The defaults are read from files, not run. A placeholder `test` script, a suite that needs a browser, or a repository whose `package.json` is in a subfolder needs a gate you write yourself.

`factory init --workspace <directory>` only creates the registry. `factory add <key> <directory>` registers one repository, inside or outside the workspace, with the same defaults; `--verify`, `--install`, `--base` and `--remote owner/repo` override them. Origin must resolve to GitHub, or be supplied with `--remote`.

## Editing in the board

The setup checklist and the agent settings of the machine are on the Settings page. The Projects page of `factory board` edits a registered project: base branch, install command, gates, and what an agent the board runs may do in it. It also registers the repositories setup would find, and removes a project.

- The base branch must exist as `origin/<branch>` in the local repository. Run `git fetch origin <branch>` first when it does not. A base branch other than `origin/HEAD` is stored with `allowBaseMismatch`, so `factory doctor` does not report it.
- A gate name uses lowercase letters, digits and hyphens, is unique in the project, and is not `install`, `reproduce` or `regress`.
- A command is one line of at most 500 characters. Join steps with `&&`, or move them into a package script. A project has at most 10 gates.
- Changing a gate's command makes its earlier runs `stale` on tasks in flight. Run the gate again with `factory run <id> <gate>`.
- Removing a project is refused while one of its tasks is in flight. The repository folder and the recorded task history stay.
- "Add a project by its folder" registers a repository anywhere on the machine: type its folder (`~` works), check the suggested commands, and save. The folder must be the root of a cloned Git repository with a GitHub origin. A project outside the workspace is stored with its full path. On a teammate's machine an imported setup looks for it in their workspace first; when it is not there, its shared settings wait and apply when they add it from wherever they keep it.
- "Agents the board runs" in the project dialog sets the project's own permission mode and extra allowed commands. They are stored under `agent` in the entry, stay on this machine, and are described in [Running an agent from the board](workflow.md#agent-settings).
- The header shows the workspace folder.

Other fields (`remote`, `dir`, `prBody`, branch conventions) are edited in `repos.json`.

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

Commit scope checks and maximum commit count are configurable. The original personal AI-attribution restriction is opt-in via `forbidAiAttribution`, not a universal factory policy. Optional metadata such as `notes`, `playbooks`, `consumers`, `prTemplate`, and `changelog` can guide your coding harness; the CLI does not automatically execute Markdown guidance.

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

`factory graph` prints the relationships; `factory graph <key>` prints what a project depends on, who uses it, and every project a change in it reaches, nearest first. A link to an unknown project or one that closes a cycle is reported and left out.

`factory doctor` reads the `package.json` files of each project (its root, its direct folders, and folders under `packages/`, `projects/` and `libs/`) and suggests links it finds there. Suggestions never change the registry and do not fail the check. Links that npm manifests cannot show, such as generated wrappers or NuGet packages, must be declared by hand. Where a manifest does show a link, the map also displays the pinned range and the version the upstream project is at; it does not judge whether the pin is out of date.

For a task, the board and `factory status` list the projects its repository reaches and whether the plan's `## Consumer impact` names each direct user, by project key or repository name. This is a reminder, not a gate: a task advances without it.

Run `factory doctor` to check configuration drift against the local repositories. The board shows projects without a gate in its setup checklist. Configure at least one meaningful verification gate before using a project for implementation work.
