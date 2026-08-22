# Modern bits/stdc++.h compatibility

This document is synchronized to the final records generated at
2026-08-21T15:33:24.941Z:

- [cpp17-compatibility-matrix.json](../compat-tests/cpp17/cpp17-compatibility-matrix.json)
- [reference-cpp17.json](../compat-tests/cpp17/reference-cpp17.json)

## v2 shim and GCC14 header evidence

The corpus-local shim is
compat-tests/cpp17/bits/include/bits/stdc++.h. Its SHA256 is
eb125843e3ff7aeda857dc8204a2f121470c43b8bcf646ab63f659cbe99762c1. The
shim uses an explicit opt-in include path and exposes 40 supported headers;
it does not emulate GNU-only APIs.

The authoritative native evidence is
compat-tests/cpp17/bits/gcc14-reference-headers.json. It records GCC 14.2.0
and native /usr/include/x86_64-linux-gnu/c++/14/bits/stdc++.h with SHA256
ab4a06fd0842e5ab78f9084c11364a06049ab5f87541541f409ecadc30a02ab6,
424 transitive headers, and the 40-header shim surface.

The GCC14 native bits A+B probe passed with input 3 5 and output 8 newline;
compileMs=1333 and runMs=2. The browser bits A+B probe also passed with
output 8 newline, compileMs=1022, linkMs=20, executionMs=2.9, cacheHit=false,
and artifactBytes=705821.

## PCH policy and measurements

The profile records pchPolicy=none, while the matrix and reference probe
records use policy DISABLED and decision PCH_DISABLED. No PCH artifact was
built or published.

The remote no-PCH benchmark has three samples, each outputting 8:

| Sample | Compile | Run |
| ---: | ---: | ---: |
| 1 | 1250 ms | 2 ms |
| 2 | 1254 ms | 2 ms |
| 3 | 1249 ms | 2 ms |

The independent Browser measurements are:

| Source | Cold compile | Cold link | Warm compile | Warm link | Cache |
| --- | ---: | ---: | ---: | ---: | --- |
| bits A+B, no PCH | 1236 ms | 21 ms | 0 ms | 0 ms | miss / hit |
| explicit includes A+B | 839 ms | 20 ms | 0 ms | 0 ms | miss / hit |

The thresholds are compileMs=500, aggregateOverheadRatio=0.25, and
minimumPchBenefitRatio=0.3. The observed coldCompileOverheadRatio is
0.4731823599523242, thresholdTriggered=true, and pchBenefitMeasured=false.
The decision remains DISABLED because no Browser PCH artifact is published.

## Header mismatch and guard probes

The ten probes intentionally omit one standard header. The final records are:

| Omitted header | GCC14 | Browser | Guard decision | Guard pass | Status |
| --- | --- | --- | --- | --- | --- |
| algorithm | COMPILE_ERROR | CE | ENABLED+PASS | true | GUARDED |
| vector | COMPILE_ERROR | CE | ENABLED+PASS | true | GUARDED |
| string | PASS | PASS | NOT_NEEDED | true | MATCH |
| map | COMPILE_ERROR | CE | NOT_NEEDED | true | MATCH |
| set | COMPILE_ERROR | CE | NOT_NEEDED | true | MATCH |
| numeric | COMPILE_ERROR | CE | NOT_NEEDED | true | MATCH |
| memory | COMPILE_ERROR | CE | ENABLED+PASS | true | GUARDED |
| functional | COMPILE_ERROR | CE | ENABLED+PASS | true | GUARDED |
| tuple | PASS | PASS | NOT_NEEDED | true | MATCH |
| optional | COMPILE_ERROR | CE | ENABLED+PASS | true | GUARDED |

For guarded cases, Browser CE and the GCC14 compile error are the expected
diagnostic pair. For MATCH cases, Browser and GCC14 agree on PASS or CE.
Every record carries the omitted header, guard decision, guard pass, and both
compiler diagnostics; no unguarded mismatch remains.

## Matrix coverage

The final browser selects all 35 feature, 45 ACM, 15 negative, and 10 warning
cases. The four UB cases are skipped by Browser as evidence-only. The three
new ACM cases are SPFA (output 0 2 1 6 4), string hash (output 0 7), and large
array (output 9900000); all pass in both GCC14 and Browser records.

## Final identity

The final profile is cpp17-gcc14-compat-v2 with local runtime status BETA and
asset hash:

8abec83e8375d5bd985f9c6fef62b2a3b3799bc7be52a89133c2689a19908419
