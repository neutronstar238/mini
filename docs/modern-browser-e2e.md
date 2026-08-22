# Modern C17/C++17 Browser E2E evidence

This document reads
[modern-cpp-e2e.json](../compat-tests/modern-cpp/results/modern-cpp-e2e.json)
without adding results from another run. The final PASS run was generated at
2026-08-21T15:44:05.907Z in Chrome against
http://127.0.0.1:55876/contest/contests/71647cca-a81a-4b27-ad1b-ef117ee2790c/problems/06cd0166-31d0-4620-a1d5-1c15db18e376.
The runtime ID was cpp-modern-engine-v2, the profiles were
c17-gcc14-compat-v2 and cpp17-gcc14-compat-v2, and the optimization policy
was -O2.

## BETA browser and UI contract

The evidence records chrome=true, progressSubscribed=true, and 260 progress
events. It also records 270 progressUi snapshots: 256 have active=true and
14 have active=false. Active snapshots include Runtime download,
WASM initialization, VFS mounting, compiler warm-up, COMPILING, and LINKING;
the final snapshot is active=false, stage=Runtime Ready, percent=100%.

progressPass=true therefore covers actual progressUi state snapshots, not only
the event count. The JSON schema exposes active, stage, and percent for these
snapshots but no separate render boolean; progressUi is the recorded rendered
UI-state evidence (the render evidence is represented by these snapshots).

The visible language options were:

- C17 Local Preview · BETA: C17 🧪 Local Preview · BETA
- C++17 Local Preview · BETA: C++17 🧪 Local Preview · BETA

The UI checks recorded localPreviewNames=true, disclaimerVisible=true,
previewDisclaimerExact=true, drawerHasV2=true, compilerDetails=true, and
formalSubmitDisabled=true. The submit control was disabled with the title
“Formal Submit 尚未启用；当前仅限 Browser Local Preview”.

The c17 and cpp17 tooltip/drawer fields identify the local compiler as Clang
19.1.7 browser WASM, with -std=c17 -O2 or -std=c++17 -O2 respectively. Both
drawers report Status=BETA, Optimization Mismatch=false, and formal GCC/G++
14.2.0 reference details with formal submit disabled. The C17 drawer reports
Header Guard=none; the C++17 drawer reports Header Guard=proven-mismatch-v1.
This is a local-preview browser record, not evidence of a formal submission.

## Modern browser matrix

The ordinary, sample, and cache cases all matched their recorded expected
outputs. The CE, RE, and header-guard controls are judged by their recorded
statuses.

| Profile | Local | Sample | Cache | CE control | RE control | Header-guard control |
| --- | --- | --- | --- | --- | --- | --- |
| c17-gcc14-compat-v2 | PASS/PASS, 42, cache miss | PASS/PASS, 15, cache hit | PASS/PASS, 15, cache hit | CE/CE, exit 1 | PASS/RE, exit 134 | null |
| cpp17-gcc14-compat-v2 | PASS/PASS, 42, cache miss | PASS/PASS, 15, cache hit | PASS/PASS, 15, cache hit | CE/CE, exit 1 | PASS/RE, exit 134 | CE/CE, exit -1, ENABLED |

For both profiles, local and sample/cache outputs matched their expected
values. The recorded local and cache artifact sizes were 55358 bytes for C17
and 705829 bytes for C++17. The outputTruncation and stderrTruncation controls
reported compile/run PASS/PASS with outputTruncated=true for both profiles.

## Cached-cold page check

The cachedCold record is a separate C++17 check. It compiled and ran
successfully, returned 10 newline, matched expected=10, and recorded
cacheHit=false with a 705829-byte artifact. Its recorded timing was
compilerInitMs=200, compileMs=2041, linkMs=64, executionMs=4.1, with
optimizationLevel=-O2. The e2e gate reports cachedColdPass=true.

The C17 boundary checks also passed as a group (limits.pass=true). The source
control recorded CE because source exceeds the 1 MiB local limit
(limitBytes=1048576, actualBytes=1048685); the input control recorded PASS /
INPUT_LIMIT because stdin exceeds the 4 MiB local limit
(limitBytes=4194304, actualBytes=4194305), with cacheHit=true.
These are limit controls, not ordinary output-compatibility cases.

## Frozen regression

The frozenRegression object records executionTimeRecorded=true and pass=true
for all four retained language controls. Their local outputs were 13 newline,
their sample and cache outputs were 8 newline, and the sample/cache controls
recorded cacheHit=true:

| Frozen control | Pass | Execution time recorded |
| --- | --- | --- |
| C | true | true |
| C++ | true | true |
| Python | true | true |
| Java | true | true |

This frozen result is a regression guard for the existing languages. It is
separate from the modern C17/C++17 BETA Local Preview cases.

## Gate result

The final JSON gate is:

| Gate field | Value |
| --- | --- |
| modernPass | true |
| limitsPass | true |
| networkPass | true |
| progressPass | true |
| cachedColdPass | true |
| largeAssetReusePass | true |
| uiPass | true |
| frozenPass | true |
| status | PASS |
