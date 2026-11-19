# Project configuration

`factory init --workspace <directory>` creates a private registry in the data directory. `factory add <key> <directory> --verify "npm run verify"` registers a local Git repository. Origin must resolve to GitHub, or be supplied with `--remote owner/repo`.

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

Run `factory doctor` to check configuration drift against the local repositories. Configure at least one meaningful verification gate before using a project for implementation work.
