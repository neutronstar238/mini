# Modern C17/C++17 optimization policy

## Decision

The Phase 8 A/B evidence selects `-O2` for the modern C17/C++17 runtime.
The decision status is `PASS`; `optimizationMismatch` is `false`.

This policy is based on the recorded result in
[`modern-cpp-optimization.json`](../compat-tests/modern-cpp/results/modern-cpp-optimization.json),
generated at `2026-08-21T14:40:37.361Z`.

## Gate thresholds and measured results

The gate requires 100% compatibility, an O2/O0 warm compile+link median ratio no
greater than 1.5, and an O2 warm compile+link P95 no greater than 5000 ms.

| Metric | `-O0` | `-O2` | Gate |
| --- | ---: | ---: | --- |
| Runs | 16 | 16 | — |
| Compatible runs | 16 | 16 | 100% required |
| Compatibility | 100% | 100% | pass |
| Median compile+link | 260 ms | 198 ms | ratio ≤ 1.5 |
| P95 compile+link | 1306 ms | 1310 ms | O2 ≤ 5000 ms |
| Median artifact | 43847 bytes | 43696 bytes | recorded |

The measured O2/O0 median ratio is `0.7615384615384615`. Every recorded GCC 14
reference case matched its expected output (`gcc14AllExpected: true`).

## Compatibility scope

The evidence covers eight representative cases, with two repetitions at each
optimization level (16 runs per level):

- C17: `c17-stdio`, `c17-math`, `c17-bfs`, `c17-dijkstra`
- C++17: `cpp17-structured-bindings`, `cpp17-optional`, `cpp17-vector`, `cpp17-algorithm`

Each browser run passed compilation and execution and matched the expected
output. The corresponding GCC 14 reference runs on the configured reference host also passed.
The reference versions recorded were:

- `gcc-14 (Ubuntu 14.2.0-4ubuntu2~24.04.1) 14.2.0`
- `g++-14 (Ubuntu 14.2.0-4ubuntu2~24.04.1) 14.2.0`

Undefined-behavior cases are explicitly excluded from compatibility rates
(`ubExcludedFromRates: true`). They must not be used to justify an optimization
policy; any future UB evidence remains separately reported.

## Operational rule

Use `-O2` as the default optimization level for well-defined C17/C++17
submissions when the same gate is still satisfied. Re-run the A/B evidence
before changing this policy. If a future run fails the compatibility gate or
the performance gate, retain the evidence, report the mismatch, and do not
silently promote the failing level.
