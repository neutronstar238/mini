# C++17 / GCC14 compatibility corpus

`matrix-manifest.json` is the single corpus index. It contains feature,
ACM-style, negative, warning, and undefined-behaviour probes together with
their input and expected-output files. `run-cpp17-matrix.mjs` reads the
`cpp17` language profile directly, runs the official GCC14 command on
`yqzl-server`, probes the modern `bits/stdc++.h` shim, records a no-PCH
benchmark/decision, and invokes the real Chrome launcher from the existing
Java E2E harness by default.

The v2 Browser run covers all features, ACM, negative, warning, and bits
probes. UB remains evidence-only. The driver also records omitted-header
mismatch probes, a bits A+B cold/warm comparison, and the PCH decision.
An alternate callable harness can be supplied through `--browser-command` or
`CPP17_BROWSER_HARNESS`.
