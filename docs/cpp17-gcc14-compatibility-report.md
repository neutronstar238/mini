# C++17 / GCC14 compatibility report

This is the final Phase 8 BETA evidence for profile cpp17-gcc14-compat-v2
and runtime cpp-modern-engine-v2. Both source records were generated at
2026-08-21T15:33:24.941Z:

- [cpp17-compatibility-matrix.json](../compat-tests/cpp17/cpp17-compatibility-matrix.json)
  records the real-Chrome browser matrix.
- [reference-cpp17.json](../compat-tests/cpp17/reference-cpp17.json) records
  the GCC14 reference matrix from the configured reference host.

The corpus is indexed by compat-tests/cpp17/matrix-manifest.json. The runner
reads server/src/language-profiles.js for the profile-derived compiler flags.

## Profile and execution

The profile is BETA, standard c++17, compiler g++-14, and reference status
GCC14_REFERENCE_READY. The recorded flags are:

~~~text
g++-14 -std=c++17 -O2 -Wall -Wextra -DONLINE_JUDGE <src> -o <out>
~~~

The reference backend is SSH to the configured reference host with a recorded 10-second
timeout. Browser execution uses real Chrome through
compat-tests/java21/e2e/harness.mjs, mode real-chrome, profile
cpp17-gcc14-compat-v2, and -O2. The browser matrix selected 105 cases and
skipped four UB cases; browserCoverageComplete=true.

## Results

| Category | Corpus | GCC14 reference | Browser |
| --- | ---: | ---: | ---: |
| C++17 features | 35 | 35/35 | 35/35 |
| ACM deterministic corpus | 45 | 45/45 | 45/45 |
| Intentional negatives | 15 | 15/15 rejected | 15/15 rejected |
| Warning probes | 10 | 10/10 | 10/10 |
| UB probes | 4 | 4/4 evidence-only | skipped; evidence-only |
| Scoreable total | 105 | 105/105 | 105/105 |
| Total corpus | 109 | 105 scoreable + 4 UB | 105 scoreable + 4 UB |

Both records report total=109, passed=105, failed=0, blocked=0, and
ubReported=4. UB is excluded from the scoreable denominator; the four UB
records remain evidence-only.

The final browser summary is passed=105, failed=0, blocked=0. Its network
summary records 492 total requests, sourceLikeRequests=0, and submissions=0.
The matrix browser status is PASS and the betaGate status is PASS.

## Newly added ACM coverage

The final ACM count includes the following three cases. Each is scoreable and
passed in both records:

| Case | Expected/output | GCC14 | Browser |
| --- | --- | --- | --- |
| acm-43-spfa | 0 2 1 6 4 | PASS | PASS |
| acm-44-string-hash | 0 7 | PASS | PASS |
| acm-45-large-array | 9900000 | PASS | PASS |

These cases are included in the 45/45 ACM and 105/105 scoreable totals; they
are not additional UB or evidence-only cases.

## bits, PCH, and header guards

The v2 shim and native GCC14 header inventory are recorded in
[modern-bits-compatibility.md](modern-bits-compatibility.md). The matrix
records pch policy DISABLED, decision PCH_DISABLED, and pchArtifactBuilt=false.
The browser PCH measurements are bits A+B cold compile 1236 ms plus 21 ms
link, warm compile/link 0/0 ms; explicit includes are 839 ms plus 20 ms cold
and 0/0 ms warm. The observed cold compile overhead ratio is
0.4731823599523242, thresholdTriggered=true, and pchBenefitMeasured=false.

Ten missing-header probes remain explicit. Guard ENABLED+PASS is recorded for
algorithm, vector, memory, functional, and optional. Guard NOT_NEEDED / MATCH
is recorded for string, map, set, numeric, and tuple. Every guard record has
guardPass=true; no unguarded mismatch remains.

## Final identity

The local runtime reports pchPolicy=none and status BETA. Its final asset hash
is:

8abec83e8375d5bd985f9c6fef62b2a3b3799bc7be52a89133c2689a19908419
