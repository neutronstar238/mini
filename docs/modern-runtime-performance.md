# Modern runtime performance and transfer evidence

The source is
[modern-cpp-performance.json](../compat-tests/modern-cpp/results/modern-cpp-performance.json),
generated at 2026-08-21T15:44:05.906Z. Values below are recorded
measurements from that final PASS run, not a broader benchmark claim.

## Cache-mode boundary

The JSON records product=normal Cache Storage and force-cache flow. It
separately records that manifest evidence may use no-store, but that this run
did not force no-store for product Local Run.

Therefore the cold/warm cacheHit values below describe the product run. They
are not no-store evidence, and no-store manifest evidence must not be
presented as product cache behavior.

## C17/C++17 run timings

| Profile | Run | WASM compile | Instantiate | Compiler init | Compile | Link | Execution | Cache hit | Artifact |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| c17 | cold | 0.6 ms | 0.4 ms | 201 ms | 365 ms | 38 ms | 2 ms | false | 55358 |
| c17 | warm | 0.7 ms | 0.3 ms | 629 ms | 0 ms | 0 ms | 1.7 ms | true | 55358 |
| cpp17 | cold | 2.1 ms | 3.4 ms | 181 ms | 1760 ms | 33 ms | 2.7 ms | false | 705829 |
| cpp17 | warm | 1.3 ms | 0.9 ms | 629 ms | 0 ms | 0 ms | 2.1 ms | true | 705829 |

All four timing records use optimizationLevel=-O2. In each profile, the
top-level cacheHit value is true after the warm run.

## Cached-cold check and large-asset reuse

The cachedCold performance record is cpp17-gcc14-compat-v2. It returned PASS /
PASS, output 10 newline, matched expected=10, and recorded cacheHit=false with
compilerInitMs=200, compileMs=2041, linkMs=64, executionMs=4.1, and a
705829-byte artifact.

The largeAssetReuse gate recorded one request and one network transfer for
each large inherited asset:

| File | Request count | Network transfers | Transfer bytes | Pass |
| --- | ---: | ---: | ---: | --- |
| clang.wasm | 1 | 1 | 54726910 | true |
| wasm-ld.wasm | 1 | 1 | 29051896 | true |
| sysroot.tar | 1 | 1 | 21258540 | true |

These are reuse evidence for the recorded product session; they do not imply
that the product Local Run was forced to no-store.

## Final compiler and page memory

The finalCompilerStats record reported READY with cacheSize=1 and
cacheCapacity=8. Its memory fields were compilerLinearMemoryBytes=null,
linkerLinearMemoryBytes=null, and cachedArtifactBytes=705829. Its counters
were compileCount=1, linkCount=1, cacheHits=0, cacheMisses=1,
bytesCompiled=705829, and bytesExecuted=0.

The pageMemory record reported jsHeapSizeLimit=4395630592,
totalJSHeapSize=164773514, and usedJSHeapSize=152710682. Its scope is the
whole Chrome page; it is not attributed solely to Modern Runtime.

The e2e timeout stats separately report cachedArtifactBytes=56941 for C17 and
770523 for C++17 after their respective timeout sequences; those values are
runtime compiler-cache evidence, not page JS heap measurements.

## Fetch timing and transfer sizes

The eleven resource entries with initiatorType=fetch were:

| Phase / resource | Duration | Transfer bytes | Encoded / decoded bytes |
| --- | ---: | ---: | ---: |
| product / v2 runtime-manifest.json | 3.8 ms | 9824 | 9524 / 9524 |
| product / v1 clang.wasm | 187.8 ms | 54726910 | 54726610 / 54726610 |
| product / v1 wasm-ld.wasm | 78.9 ms | 29051896 | 29051596 / 29051596 |
| product / v1 clang.js | 3.2 ms | 78909 | 78609 / 78609 |
| product / v1 wasm-ld.js | 1.8 ms | 76648 | 76348 / 76348 |
| product / v1 sysroot.tar | 80.3 ms | 21258540 | 21258240 / 21258240 |
| product / v1 loader.mjs | 1.9 ms | 1754 | 1454 / 1454 |
| product / v2 bits/stdc++.h | 2.6 ms | 1213 | 913 / 913 |
| product / ide-wasi-worker-modern.js | 2.6 ms | 56240 | 55940 / 55940 |
| product / ide-wasi-execution-worker-modern.js | 2.4 ms | 5247 | 4947 / 4947 |
| cached-cold-page / v2 runtime-manifest.json | 2 ms | 9824 | 9524 / 9524 |

The resources array contains 29 entries; its other entries are worker timing
records with initiatorType=other, including negative durations, so they are
not used as fetch-latency claims. The totals object records
transferBytes=105282405, encodedBytes=105464737, and decodedBytes=105464737.
The difference between the recorded transfer total and the encoded/decoded
totals is reported as-is; this document does not infer a cause absent from
the JSON.

## Content-Encoding

All eleven responseHeaders records have contentEncoding=identity. The header
contentLength values are:

| Header record | Content length | Content type |
| --- | ---: | --- |
| v2 runtime-manifest.json | 9524 | application/json; charset=UTF-8 |
| v1 clang.wasm | 54726610 | application/wasm |
| v1 wasm-ld.wasm | 29051596 | application/wasm |
| v1 clang.js | 78609 | application/javascript; charset=UTF-8 |
| v1 wasm-ld.js | 76348 | application/javascript; charset=UTF-8 |
| v1 sysroot.tar | 21258240 | application/x-tar |
| v1 loader.mjs | 1454 | application/javascript; charset=UTF-8 |
| v2 bits/stdc++.h | 913 | text/x-c; charset=UTF-8 |
| ide-wasi-worker-modern.js | 55940 | application/javascript; charset=UTF-8 |
| ide-wasi-execution-worker-modern.js | 4947 | application/javascript; charset=UTF-8 |
| v1 THIRD_PARTY_NOTICES.md | 122559 | text/markdown; charset=UTF-8 |

The captured headers therefore contain no compressed Content-Encoding result
for these eleven records. Header contentLength remains distinct from the
performance resource transferBytes values.
