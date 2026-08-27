# WebJudge repository harness

This file applies to people and AI assistants working in this repository.

## Scope first

- Before editing, state the files or modules that the task is allowed to change and the command that will prove completion.
- Keep changes inside that declared scope. Do not reformat, rename, or remove unrelated files.
- Treat `server/public/js/runno/`, `server/public/js/pyodide/`, generated runtime binaries, compatibility corpora, and `server/data/` as read-only unless the task explicitly names them.
- Never write credentials, tokens, private keys, production domains, personal server aliases, or absolute deployment paths into source, reports, examples, or logs.
- Do not add or upgrade dependencies unless the task explicitly requires it and the relevant manifest and lockfile changes are reviewed together.
- Do not commit one-off probes, local captures, or task-specific harnesses. Keep them under ignored `tmp/` or `output/`. A permanent script must be referenced by an npm command, repository documentation, or a reproducible committed evidence artifact.

## Completion gate

A task is complete only when all of the following are true:

1. The declared scope check passes.
2. The narrow test for each changed behavior passes.
3. Existing relevant smoke tests still pass when the task can affect them.
4. `git diff --check` reports no whitespace errors, and `git status --short` contains no unexplained files.

For every change, run the repository unit/static gates:

```powershell
Push-Location server
npm test
npm run test:runtime-catalog
Pop-Location
git diff --check
```

When a change affects HTTP routes, browser runtimes, submissions, SSE, or the scoreboard, also start the local contestant service and run the relevant E2E commands documented in `README.md`. Pass the base URL as a command argument; do not commit a production address.
