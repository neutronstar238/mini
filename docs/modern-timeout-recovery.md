# Modern C17/C++17 timeout recovery evidence

This record is derived only from
[modern-cpp-e2e.json](../compat-tests/modern-cpp/results/modern-cpp-e2e.json),
generated at 2026-08-21T15:44:05.907Z. The final PASS browser run used
cpp-modern-engine-v2, the c17-gcc14-compat-v2 and cpp17-gcc14-compat-v2
profiles, and the recorded optimization policy was -O2.

## Local timeout records

The timeout case is a browser-local protection. Both profiles compiled
successfully, then reported TLE after 6000 ms with exitCode -1, timedOut=true,
and aborted=true. The recorded diagnostic says that the local 6-second timeout
is for debugging protection and that formal TLE is decided by the server Judge.

| Profile | Compile / run | Execution | Artifact | Worker preserved |
| --- | --- | ---: | ---: | --- |
| c17-gcc14-compat-v2 | PASS / TLE, exit -1 | 6000 ms | 809 bytes | true |
| cpp17-gcc14-compat-v2 | PASS / TLE, exit -1 | 6000 ms | 809 bytes | true |

The timeout records have cacheHit=false. The evidence therefore does not
claim that the timed-out invocation itself was served from cache.

## Compiler state after timeout

The next stats request for each profile reported READY and ready=true. Both
records verified compiler glue, linker glue, and the proxy filesystem; the
proxy filesystem was mounted at /shared from clang.FS to wasm-ld.FS. The
runtimeAssetHash was the same in both records:
8abec83e8375d5bd985f9c6fef62b2a3b3799bc7be52a89133c2689a19908419.

| Profile | Stats request | State | Cache size / capacity | Cache hits / misses | Compile / link count | Bytes compiled |
| --- | ---: | --- | --- | --- | --- | ---: |
| c17-gcc14-compat-v2 | 6 | READY | 3 / 8 | 1 / 4 | 4 / 3 | 56941 |
| cpp17-gcc14-compat-v2 | 15 | READY | 8 / 8 | 3 / 10 | 10 / 8 | 770523 |

The post-timeout memory fields reported compilerLinearMemoryBytes=null and
linkerLinearMemoryBytes=null. cachedArtifactBytes was 56941 for C17 and
770523 for C++17. The stats records report bytesExecuted=0.

This is the post-timeout Compiler READY evidence. It is separate from the
timeout result itself: the timeout was TLE, while the following stats request
was READY.

## Alive and cache recovery

The explicit run after the stats request passed for both profiles:

| Profile | Compile / run | Output | Output match | Cache hit | Artifact | Worker preserved |
| --- | --- | --- | --- | --- | ---: | --- |
| c17-gcc14-compat-v2 | PASS / PASS, exit 0 | 3 newline | true | true | 55358 bytes | true |
| cpp17-gcc14-compat-v2 | PASS / PASS, exit 0 | 3 newline | true | true | 705829 bytes | true |

Thus the evidence supports all three recovery observations requested by this
gate: the Compiler remained READY, the cache was usable on the subsequent run,
and the runtime remained ALIVE. It does not turn the local timeout into an
official Judge TLE result.

## Related controls

The separate RE controls compiled successfully and reported RE with exitCode
134 for both profiles; each preserved the compiler worker and produced a
774-byte artifact. The outputTruncation and stderrTruncation controls also
passed compilation and execution for both profiles. Output truncation recorded
1048576 stdout bytes and a 3224-byte artifact; stderr truncation recorded a
2946-byte artifact. These controls remain distinct from timeout recovery.

The e2e gate reports modernPass=true and overall status PASS. The BETA UI,
progress, cached-cold, large-asset-reuse, and frozen-regression gates are
documented separately in the browser e2e document.
