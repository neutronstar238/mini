# C17 / GCC14 Compatibility Beta Gate

Generated corpus and matrix driver for Phase 8. The corpus is intentionally split
into scoreable C17 programs and diagnostics:

| Suite | Cases | Scoring |
|---|---:|---|
| positive | 36 | GCC14 and Browser compile/run, exact trimmed stdout |
| acm-corpus | 30 | GCC14 and Browser compile/run, exact trimmed stdout |
| negative | 15 | expected compile error (CE) |
| warnings | 10 | GCC14 compile success plus at least one warning; Browser score is compile success because the Browser runner does not expose a warning stream |
| ub | 4 | compile-only and explicitly not counted in the gate |

Every case directory contains main.c, input.txt, expected.txt, and meta.json.

## Driver

From the repository root:

~~~text
node compat-tests/c17/run-c17-compatibility.mjs --server --browser
~~~

The driver imports server/src/language-profiles.js and uses the C17
officialJudge.compileCommand; it does not duplicate the GCC14 flags. It uploads
sources to ssh yqzl-server, probes gcc-14 --version, compiles/runs the
scoreable cases, and records compiler diagnostics. SSH is BatchMode-only with a
bounded connection timeout and transient connection retries.

A completed GCC14 reference can be reused while iterating on Browser runtime
assets:

~~~text
node compat-tests/c17/run-c17-compatibility.mjs --reuse-server --browser
~~~

If a prior reference has transiently blocked cases, retry only those cases:

~~~text
node compat-tests/c17/run-c17-compatibility.mjs --reuse-server --retry-blocked
~~~

Use --strict when a non-PASS matrix should return exit code 1. The driver never
converts an unavailable backend into a pass: remote failures are BLOCKED, and
an unrequested Browser run is NOT_RUN.

The outputs are:

- compat-tests/c17/reference-c17.json: GCC14 reference, profile command,
  compiler version, diagnostics, and per-case verdicts.
- compat-tests/c17/c17-compatibility-matrix.json: server/browser evidence,
  comparison results, corpus counts, and blockers.

## Evidence status

The completed GCC14 reference used the declared remote compiler
gcc-14 (Ubuntu 14.2.0-4ubuntu2~24.04.1) 14.2.0. All scoreable server cases
matched:

- positive: 36/36
- ACM corpus: 30/30
- negative CE: 15/15
- warnings: 10/10
- UB: 4, not counted

After the modern v2 manifest became available, the existing reference was
reused and the full Browser harness was run with -O2. The gate is now PASS:

- positive: 36/36 Browser matches
- ACM corpus: 30/30 Browser matches
- negative CE: 15/15 Browser matches
- warnings: 10/10 Browser compile-pass matches
- matrix blockers: 0

The generated matrix records the Browser problem URL, profile, optimization
level, per-case stdout/stderr, and the exact server/browser comparisons.
