---
name: factory-verify
description: Independently verify a Code Factory task before human approval - rerun its gates, check each acceptance criterion and each PR claim, and record a pass or fail verdict. Use in a fresh session or as the factory-verifier agent, never in the session that wrote the code.
---

# Verifying a factory task

You did not write this change. Judge it from the records and the code, not from the builder's account of it. Change no source files.

1. `factory status <id>`: note the worktree, HEAD and tier. The tree must be clean.
2. Rerun every gate yourself: `factory run <id> <gate> --as verifier`. A gate that fails is a `fail` verdict.
3. Read `plan.md`. For each item under `## Acceptance criteria`, find the test or run the command that shows it holds at HEAD. A criterion you cannot demonstrate is a finding.
4. Read `pr-body.md`. Check every factual claim against the diff (`git diff <merge-base>..HEAD` in the worktree).
5. Read the tests the change adds. Each must assert behaviour and must fail without the fix. For a bug, check the regression record: the base run must fail for the bug itself, not for a missing import or a syntax error.
6. Look once for: secrets or credentials in the diff, unescaped external strings in HTML, unsafe shell or SQL built from input, and changes outside the stated scope.
7. Write the report to a file outside the worktree. Start with a section headed `Acceptance criteria` listing each criterion, the command that checked it and the result. Then list the PR claims the same way, then findings marked blocking or non-blocking.
8. Record it: `factory verdict <id> pass|fail --report <file>`. Record `fail` if any blocking finding stands.

Never run `factory approve`, never push, and never edit state, evidence or `verify.md` by hand.
