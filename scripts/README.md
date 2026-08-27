# Script classification

Only repeatable project checks and evidence generators belong in this directory.
One-off probes, copied production commands, local screenshots, and ad-hoc reports
must stay under the ignored `tmp/` or `output/` directories.

## Required delivery gates

- `e2e/runtime-catalog-check.mjs`: validates committed Runtime manifests and asset metadata.
- `e2e/release-readiness-smoke.mjs`: validates a running OJ Core's health, readiness, HTML shell, and public Runtime catalog.
- `e2e/oj-main-path.js`: validates the authoritative submission and verdict path on an isolated seeded service.
- `e2e/phase5-scoreboard-sse.js`: validates scoreboard, SSE, cache lease, and rejudge behavior.

Run the stable entry points through `server/package.json`; see the testing section
in the repository `README.md`.

## Browser and compatibility regression

The remaining `e2e/` scripts, compatibility drivers, and setup scripts reproduce
the published C/C++/Python/Java Runtime matrices and browser results. They are not
part of the fast per-commit gate because they require a browser, reference compiler,
or prepared corpus, but they are retained so published capability claims remain
reproducible.

## Build, evidence, and stress tools

- Root-level `build-*`, `generate-*`, `evaluate-*`, and `verify-*` scripts build or validate committed Runtime evidence.
- `data/` contains deterministic corpus builders; downloaded caches stay under ignored `tmp/`.
- `stress/` contains explicit load and memory tests; generated metrics stay under ignored `output/`.
