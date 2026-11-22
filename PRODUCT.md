# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Any developer who supervises AI coding agents working on GitHub issues and pull requests. They install Codeignite from the README, with nobody to explain it, and run it on their own machine against their own repositories. They may not know every repository in their workspace. They come to the board between other work to see what each task needs and to make the decisions only a human makes: approve, send back, archive.

## Product Purpose

Codeignite takes a GitHub issue or pull request through implementation, recorded checks, independent verification and human approval. The `factory` CLI runs the pipeline and the board at `http://127.0.0.1:4317` shows it. Success is a change that reaches human approval with its evidence attached, and a developer who can tell in one look whose turn it is.

## Positioning

A repeatable pipeline. Every task goes through the same stages, gates and brakes. The stages, checks, skills and agents are configurable per project, and one export file gives a team the same projects, gates and workflow.

## Operating Context

- Runs locally. The server listens on `127.0.0.1`, and project data lives in `~/.code-factory`, outside this repository.
- Works on Git worktrees and through the GitHub CLI (`gh`). Requires Node.js 22 or newer. macOS and Linux are the targets; Windows is not validated.
- Any coding harness can use the CLI. Transcript attribution, guard hooks and running an agent from the board are built for Claude Code, behind an adapter that other agents can implement.
- The board updates when task data changes and keeps open forms and explanations until the user finishes interacting.

## Capabilities and Constraints

- Board with five columns: Understand, Build, Check, Your turn, Ship. A list view groups the queue by what needs the user.
- Task page: what the stage needs next, then three tabs that follow the step. Review holds the PR description or review draft and the diff by file; Proof holds checks, acceptance criteria and evidence runs with log tails, failures first; Details holds the issue, triage, plan, brief, agent activity, usage and archive, each opened on demand.
- Approval is checked by the backend and bound to the displayed commit or draft. Creating a pull request or posting a review is a separate, explicit action.
- Projects page, Workflow page, workspace map, GitHub issues view, Daily report, metrics, and a Settings page with the setup checklist and agent settings. "New task" is on the Work queue only.
- Token counts per task and session, with electricity and carbon scenarios whose assumptions and formulas are shown.
- "Run agent" starts the user's own coding agent in the background, one session per step, until the task needs the user. What it may do, how many run at once and the account are settings of the machine.
- After a pull request opens the board follows its checks and reviews and brings failures and feedback to the user, who decides what goes back to the agent.
- The tab title counts the tasks that wait for the user, and an optional system notification tells them when a task newly needs them. Both work from the open board tab; nothing is sent anywhere.
- Brakes: a limit on failed attempts, and "Send back" with a lesson that later briefs carry.
- Constraint: local only. No hosted version, accounts or telemetry.
- Current state, not confirmed as a commitment: the board is plain HTML, CSS and JS with no runtime npm dependencies and no build step.

## Brand Commitments

- The interface is compact and dark. No light theme is planned.
- Current name and logo: Codeignite, `web/logo.svg`. Not confirmed as fixed.

## Evidence on Hand

- `README.md` and `docs/` (`workflow.md`, `projects.md`, `calculations.md`, `claude-code.md`, `migration.md`) describe real behavior.
- `docs/calculations.md` holds the sources and formulas behind the electricity and carbon figures.
- No testimonials, customer names, benchmarks or pricing exist. Future work does not invent them.

## Product Principles

1. The same pipeline for every task. A stage, gate or brake means the same thing in every project.
2. Nothing is approved on an agent's word. An approval covers the exact commit or draft on screen, with its evidence.
3. Say whose turn it is. Each task states what it needs next and from whom.
4. Explain itself to a stranger. A developer who has never seen the repositories or the tool understands a screen without outside help. The explanations are one switch away ("? Explain"), so a screen shows status and the next action first and does not repeat what a returning user knows.
5. Stay on the user's machine. Project data does not leave it.
