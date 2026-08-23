# Codeforces real-source browser compatibility report

Generated on 2026-08-23. This report tests real contest source compatibility
inside the browser runtimes. It does not evaluate server Judge throughput,
submission concurrency, or scoreboard capacity.

## Source availability boundary

The official Codeforces `contest.status` API can return every submission's
metadata, but anonymous `includeSources=true` requests fail with:

```text
includeSources: Only managers can include source, see asManager parameter
```

An anonymous real-browser session could list submissions but could not open
their source details. Therefore a reproducible public dataset was used instead:
`open-r1/codeforces-submissions`, whose rows contain `source`, `og_source`,
language, verdict, problem, and submission ID. Test inputs and expected outputs
came from `open-r1/codeforces` generated tests plus Codeforces statement samples.

## Contest selected

Codeforces contest 908 was chosen because it contains multiple source families.
The complete source dataset reports 15,494 unique submissions in 28 language
labels:

| Language | Submissions |
| --- | ---: |
| C++14 (GCC 6-32) | 7,236 |
| GNU C++11 | 3,645 |
| GNU C++ | 1,590 |
| Python 3 | 1,295 |
| Java 8 | 664 |
| PyPy 3 variants | 376 |
| MS C++ | 168 |
| GNU C / GNU C11 | 152 |
| Other 19 labels | 368 |

Not all 15,494 submissions should produce correct output: the full dataset also
contains WA, CE, TLE, and other rejected submissions. Correct-output validation
must therefore use Accepted submissions.

The executable `selected_accepted` subset supplied 40 original Accepted
sources: five per problem across eight problems. None had been rewritten:
`source == og_source` for all 40.

| Original language | Sources | Browser mapping |
| --- | ---: | --- |
| C++14 (GCC 6-32) | 20 | C++17 Modern Engine v2 |
| GNU C++ | 9 | C++11 frozen runtime |
| GNU C++11 | 8 | C++11 frozen runtime |
| MS C++ | 1 | C++11 frozen runtime |
| Python 3 | 1 | Python 3.12 / Pyodide |
| Java 8 | 1 | Java 21 / BrowserJDK |

The corpus contained 103 tests. The post-fix replay performed all 515 applicable
source/test executions.

## Browser result

| Original language | Sources | Baseline all-pass | Post-fix compiled | Post-fix all-pass |
| --- | ---: | ---: | ---: | ---: |
| C++14 | 20 | 18 | 20 | 20 |
| GNU C++ | 9 | 4 | 9 | 9 |
| GNU C++11 | 8 | 4 | 8 | 8 |
| MS C++ | 1 | 0 | 1 | 1 |
| Python 3 | 1 | 1 | 1 | 1 |
| Java 8 | 1 | 0 | 1 | 1 |
| **Total** | **40** | **27** | **40** | **40** |

Post-fix result:

- 40/40 sources compiled;
- 40/40 passed every available test;
- 515/515 executed test runs matched expected output;
- zero compile failures, timeouts, runtime errors, or output mismatches.

## Fixes applied

### 1. Long-stdin alignment and status propagation

The runner now rounds the complete stdin `SharedArrayBuffer` length up to an
`Int32Array` boundary. Data and EOF delivery are serialized, and stdin,
`postMessage`, Worker, and non-zero-exit failures are surfaced as `RE` rather
than `PASS` with empty output. The seven previously affected sources now pass
all E/F tests.

### 2. GNU PBDS compatibility overlay

Modern Engine v2 now mounts project-owned compatibility headers for common
`tree`, `find_by_order`, `order_of_key`, `gp_hash_table`, and `cc_hash_table`
source APIs. The two real PBDS submissions now compile and pass. The
order-statistics compatibility implementation is correctness-oriented and uses
linear traversal, so it is not a performance-equivalent GNU PBDS replacement.

### 3. C++11 warning and `%I64d` compatibility

C++11 Runtime v5 no longer promotes every Clang warning to CE; genuine syntax
and semantic errors still fail via the compiler exit code. Historical
`%I64[d/i/o/u/x/X]` conversions inside string literals are normalized to their
C99 `%ll...` equivalents for WASI libc. The three previously rejected sources
now pass, while the C++14 generic-lambda negative test remains CE.

### 4. Java Zero execution protection

Java now has a dedicated 15-second local execution limit, forwarded to the
BrowserJDK worker and loader. C/C++ and Python retain their existing six-second
limits. The previously timing-out Java H source passes all tests with the Java
limit; infinite/long-running code remains interruptible and recoverable.

## Safety and reproducibility

Third-party sources ran only inside browser workers. After the page loaded, the
browser context allowed only same-origin GET requests for the runtime and worker
assets. All other requests were aborted. Three Mini-OJ page background requests
were blocked; no submission attempted network I/O.

Corpus preparation used lazy Parquet filtering. The replay command was:

```powershell
$env:BASE_URL='http://127.0.0.1:3101'
$env:CF_COMPAT_CORPUS=Join-Path $PWD 'tmp\codeforces-compat\contest-908-corpus.json'
$env:CF_COMPAT_RUN_TIMEOUT_MS='30000'
$env:CF_COMPAT_REPORT=Join-Path $PWD 'output\codeforces-908-browser-compat-after-fixes.json'
node scripts/e2e/codeforces-browser-compat.mjs
```

The post-fix raw result is written to
`output/codeforces-908-browser-compat-after-fixes.json`.

## Compatibility verdict

The measured real-source compatibility result improved from 27/40 (67.5%) to
40/40 (100%) for this selected Accepted corpus, with 515/515 output matches.
This is evidence for the tested C++/Python/Java source families, not a claim of
complete Codeforces compatibility: the subset does not include C, the public
tests are not Codeforces' hidden judge suite, and only 40 Accepted originals
were executed out of the dataset's 15,494 contest rows.
