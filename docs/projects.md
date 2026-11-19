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

Commit scope checks and maximum commit count are configurable. The original personal AI-attribution restriction is opt-in via `forbidAiAttribution`, not a universal factory policy. Optional metadata such as `notes`, `playbooks`, `consumers`, `prTemplate`, and `changelog` can guide your coding harness; the CLI does not automatically execute Markdown guidance.

Run `factory doctor` to check configuration drift against the local repositories. Configure at least one meaningful verification gate before using a project for implementation work.
