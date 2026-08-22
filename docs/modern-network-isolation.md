# Modern runtime network isolation evidence

This document is based on
[modern-cpp-network.json](../compat-tests/modern-cpp/results/modern-cpp-network.json),
generated at 2026-08-21T15:44:02.467Z. Its trace used the local problem URL
http://127.0.0.1:55876/contest/contests/71647cca-a81a-4b27-ad1b-ef117ee2790c/problems/06cd0166-31d0-4620-a1d5-1c15db18e376.

## Recorded policy result

| Field | Recorded value |
| --- | ---: |
| Total requests | 114 |
| Local-run network requests | 87 |
| Runtime requests | 87 |
| Allowed policy | same-origin GET runtime assets only |
| Runtime request violations | 0 |
| Source-like requests | 0 |
| Submission requests | 0 |
| Policy pass | true |

The policy object records 26 inProcessBlobRequests and one
unrelatedBackgroundRequest. All 26 in-process blob requests are GET script
loads with bodyBytes=0 and hasSourceLikeBody=false. The one background request
is a POST heartbeat with bodyBytes=351 and hasSourceLikeBody=false; it is
explicitly classified as unrelatedBackgroundRequests, not a submission.

The empty arrays in the JSON are the evidence for
runtimeRequestViolations, sourceLikeRequests, and submissionRequests. The
trace therefore passed the declared isolation policy.

## Runtime request shape

Filtering the recorded request list to URLs containing
/runtime/cpp-modern-engine produced 13 requests. All 13 were GET requests
with resourceType=fetch, covering eight unique URLs:

- runtime/cpp-modern-engine-v1/clang.js
- runtime/cpp-modern-engine-v1/wasm-ld.js
- runtime/cpp-modern-engine-v1/sysroot.tar
- runtime/cpp-modern-engine-v1/loader.mjs
- runtime/cpp-modern-engine-v2/bits/stdc++.h
- runtime/cpp-modern-engine-v2/runtime-manifest.json
- runtime/cpp-modern-engine-v1/clang.wasm
- runtime/cpp-modern-engine-v1/wasm-ld.wasm

The 87 runtime requests in policy are the trace-level runtime count; the 13
above are the direct cpp-modern-engine URL subset and include repeated loads.
They should not be interpreted as 13 unique network resources in total.

## Cache and no-store evidence boundary

This network JSON records URL, method, and resource type for the trace, but it
does not record a request cache mode or response Content-Encoding/header set.
Accordingly, it is isolation evidence, not direct no-store evidence.

The separate performance JSON states:

- product: normal Cache Storage and force-cache flow;
- evidenceHarness: manifest evidence may use no-store; this run did not force
  no-store for product Local Run.

Those statements must not be collapsed. “No source/submission request” is a
network-isolation finding; it does not mean the product Local Run bypassed its
cache. Conversely, the product cache flow does not prove that a separate
manifest-evidence harness run used no-store.
