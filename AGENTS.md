# WebJudge repository harness

This file applies to people and AI assistants working in this repository.

## Scope first

- Before editing, state the files or modules that the task is allowed to change and the command that will prove completion.
- Keep changes inside that declared scope. Do not reformat, rename, or remove unrelated files.
- Treat `server/public/js/runno/`, `server/public/js/pyodide/`, generated runtime binaries, compatibility corpora, and `server/data/` as read-only unless the task explicitly names them.
- Never write credentials, tokens, private keys, production domains, personal server aliases, or absolute deployment paths into source, reports, examples, or logs.
- Do not add or upgrade dependencies unless the task explicitly requires it and the relevant manifest and lockfile changes are reviewed together.

## Completion gate

A task is complete only when all of the following are true:

1. The declared scope check passes.
2. The narrow test for each changed behavior passes.
3. Existing relevant smoke tests still pass when the task can affect them.
4. `git diff --check` reports no whitespace errors, and `git status --short` contains no unexplained files.

For the Day 6 work, run:

```powershell
node scripts/harness/check-day6-scope.mjs
node scripts/e2e/day6-readiness-smoke.mjs $env:WEBJUDGE_BASE_URL
node scripts/e2e/day6-runtime-catalog.mjs $env:WEBJUDGE_BASE_URL
git diff --check
```

Supply `WEBJUDGE_BASE_URL` through the environment; do not commit a production address. The first command is the boundary check. A file outside the Day 6 allowlist, a dependency manifest change, or a likely secret makes it fail before the work is accepted.
