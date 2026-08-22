# C17/C++17 Formal Submit Enablement

## Result

- Production URL: `https://contest.mini.nstarzx.cn`
- Test contest: `Browser OJ E2E Test` (`b0f5796b-7d30-4241-9326-b5d8c3ce8363`)
- Final release: `20260822T032542Z-b6e04e8-c17-cpp17-formal-enabled-r2`
- C17 Formal Submit: **ENABLED**
- C++17 Formal Submit: **ENABLED**
- Final acceptance result: **PASS**

Formal Submit was first exposed only to the test contest through a server-side canary allowlist. The global canary restriction was removed only after the sandbox, API acceptance, real-browser acceptance, SSE, scoreboard, hidden-test boundary, and compiler evidence checks passed.

## Safety and rollback

- Verified pre-change backup: `/www/backups/mini-oj/pre-formal-submit-enablement-20260822T025254Z`
- Backup SHA256 verification: PASS
- Backup SQLite integrity: PASS
- Pre-change counts: users 6, contests 4, problems 6, submissions 69
- Candidate release: `20260822T031648Z-b6e04e8-formal-canary4`
- Promotion rollback target: the tested canary release with the test-contest-only gate restored
- Final database integrity: `ok`
- Final submission count: 95
- Final in-flight submission count: 0

## Official Judge security boundary

Production judging is fail-closed and requires `JUDGE_SANDBOX_MODE=systemd` with `JUDGE_SANDBOX_REQUIRED=1`. There is no production fallback to a direct child process.

Each compiler and submitted program runs in a transient systemd unit with a non-privileged user, private network/IPC/tmp/devices, read-only protected system paths, hidden deployment trees, a clean environment allowlist, no capabilities, `NoNewPrivileges`, syscall-family restrictions, cgroup memory/swap/task limits, CPU/runtime/file limits, and whole-unit termination on timeout or excessive output.

Production probes passed:

- C17 compilation and execution inside the sandbox: PASS
- C++17 `bits/stdc++.h` compilation and execution inside the sandbox: PASS
- Read `/www/.../oj-main-path.db`: BLOCKED
- Create an `AF_INET` socket: BLOCKED
- Read `INTERNAL_API_SECRET` from the service environment: BLOCKED
- C11, C++11, Python 3.12, and Java 21 sandbox smoke: AC

## Compiler evidence

| Language | Actual path | Actual version | Standard | Optimization |
|---|---|---|---|---|
| C17 | `/usr/bin/gcc-14` | `gcc-14 (Ubuntu 14.2.0-4ubuntu2~24.04.1) 14.2.0` | `c17` | `-O2` |
| C++17 | `/usr/bin/g++-14` | `g++-14 (Ubuntu 14.2.0-4ubuntu2~24.04.1) 14.2.0` | `c++17` | `-O2` |

The Judge verdict log records the actual compiler path/version/standard/optimization for each modern-language submission. The modern profiles reject any compiler command other than the exact GCC 14 paths; there is no gcc/g++ 11, generic gcc/g++, or Clang fallback.

Examples from the real-browser run:

- C17 AC `65cff4bb-5a8b-4dab-a3a5-d96c79cca183`: `/usr/bin/gcc-14`, 14.2.0, AC
- C++17 bits AC `4e296c7b-a90c-40f2-a7a6-d28d3ca790dc`: `/usr/bin/g++-14`, 14.2.0, AC
- Post-enable C17 AC `31aae831-6c98-438e-adb6-53e4d006fba1`: `/usr/bin/gcc-14`, 14.2.0, AC
- Post-enable C++17 AC `90646c6d-2964-4eb1-83f2-eebb2577364e`: `/usr/bin/g++-14`, 14.2.0, AC

## API acceptance matrix

Evidence: `tmp/c17-cpp17-formal-submit-20260822031214.json`

| Case | Submission | Expected | Actual | State machine | SSE |
|---|---|---:|---:|---:|---:|
| C17 AC | `f071b0a7-115b-4e1c-97a1-d674b93ae563` | AC | AC | PASS | PASS |
| C17 CE | `ceaebcd4-f889-48e0-ae8d-f29282a994d9` | CE | CE | PASS | PASS |
| C17 RE | `a7691b2c-496c-4763-ac1b-caefaac79134` | RE | RE | PASS | PASS |
| C17 WA | `3950cdeb-0749-4823-aba4-8e263777b1b8` | WA | WA | PASS | PASS |
| C++17 AC | `3f942288-569f-47d9-a4e2-706058fdfc3e` | AC | AC | PASS | PASS |
| C++17 bits AC | `d48b90b0-009d-479f-ae30-1c21898b8e39` | AC | AC | PASS | PASS |
| C++17 CE | `4ad79958-e7a8-4e74-bc3b-715f3075e92b` | CE | CE | PASS | PASS |
| C++17 RE | `b3973be0-603e-4360-ae85-e6d873c2ae28` | RE | RE | PASS | PASS |
| C++17 WA | `692d4bbf-ba1a-4564-b29f-2fd302910a35` | WA | WA | PASS | PASS |

All client-request-id replay checks returned the same submission ID and created no duplicate submission.

## Real-browser acceptance matrix

All actions below were performed from the production contestant UI. The submissions page held an open SSE connection before each submit and was not refreshed.

| Case | Submission | Expected | Actual | Browser SSE |
|---|---|---:|---:|---:|
| C17 AC | `65cff4bb-5a8b-4dab-a3a5-d96c79cca183` | AC | AC | `QUEUED → JUDGING → FINISHED` |
| C17 CE | `164299fa-2456-4921-b297-0304d4ea998c` | CE | CE | `QUEUED → JUDGING → FINISHED` |
| C17 RE | `3304c596-0db2-44ec-95e1-20c9d7746dc3` | RE | RE | `QUEUED → JUDGING → FINISHED` |
| C17 WA | `754f714b-1459-4044-ab0b-7d51dca56dca` | WA | WA | `QUEUED → JUDGING → FINISHED` |
| C++17 AC | `1f74d8ec-08c6-47e1-afd9-34bf92991e89` | AC | AC | `QUEUED → JUDGING → FINISHED` |
| C++17 bits AC | `4e296c7b-a90c-40f2-a7a6-d28d3ca790dc` | AC | AC | `QUEUED → JUDGING → FINISHED` |
| C++17 CE | `b47ee282-af57-4d95-89d4-c7ae1bb27a23` | CE | CE | `QUEUED → JUDGING → FINISHED` |
| C++17 RE | `9cf09693-2be0-412b-a068-bd2aaed17928` | RE | RE | `QUEUED → JUDGING → FINISHED` |
| C++17 WA | `b7d87fc4-d03a-4ae5-a5c3-2173a1043c27` | WA | WA | `QUEUED → JUDGING → FINISHED` |

For every browser submission, SQLite records a strictly ordered `server_received_at`, `judge_started_at`, and `judge_finished_at`, and the final status is `FINISHED`.

## Browser versus Official Judge

- C17 Browser Local input `3 5`: stdout `8`; Official Judge: AC
- C++17 `bits/stdc++.h` Browser Local input `3 5`: stdout `8`; Official Judge: AC
- Browser runtime shown for both languages: Modern C/C++ Engine v2, Clang/LLD 19.1.7
- Official compiler remained GCC/G++ 14.2.0 as proven by the Judge logs

Result: **PASS**

## Scoreboard

A correct C17 submission to test problem C (`1718d3c2-d636-4cfd-b446-84af710add84`) changed the already-open scoreboard without a refresh:

- Version: `v6 → v7`
- user1 solved: `1 → 2`
- Problem C changed from failed attempts to solved
- CE/RE/WA cases did not create solved cells

Result: **PASS**

## Hidden-test isolation

- The contestant problem page displayed no hidden testcase count or data.
- Public problem, submission detail, scoreboard, and SSE payloads were checked for hidden input/output, expected-output, filesystem-path, testcase, generator, and solution fields; none were present.
- SSE payloads contained submission identity, public status/verdict, time, and memory only.
- Submitted source is transferred as required; hidden tests remain server-side and are passed only to the isolated Judge process.
- Filesystem/network/environment sandbox probes passed.

Result: **PASS**

## Post-enable production smoke and legacy regression

The test account was logged out and logged in again after global promotion. C17 and C++17 submit buttons were enabled on the freshly entered contest.

| Language | Submission | Result | SSE |
|---|---|---:|---:|
| C17 | `31aae831-6c98-438e-adb6-53e4d006fba1` | AC | PASS |
| C++17 | `90646c6d-2964-4eb1-83f2-eebb2577364e` | AC | PASS |
| C11 | `ba9926d6-0ea6-4570-b595-e880408250c8` | AC | PASS |
| C++11 | `94eb0a06-4c25-4145-b103-340b8cc44d72` | AC | PASS |
| Python 3.12 | `f6741b2b-9b25-4ad6-9ced-fb430feb9899` | AC | PASS |
| Java 21 | `b2b77663-aa66-4110-b260-1f5747afa682` | AC | PASS |

## User-visible language and environment state

The selector displays exactly:

1. C11
2. C++11
3. C17
4. C++17
5. Python 3.12
6. Java 21

Switching the selector updates the top runtime label to the selected language. C17/C++17 also switch to fixed `-O2` and disabled PCH as defined by their modern profiles. All six Formal Submit gates resolve correctly on initial load and after language changes.

The Runtime Info page reports only user-facing support/compiler labels. It contains none of `BETA`, `BETA_FROZEN`, `EXPERIMENTAL`, or `LOCAL_PREVIEW`; internal profile status values remain unchanged.

## Logs and operational state

- PM2 contest service: online
- Global canary list: empty
- Sandbox mode: `systemd`, required: `1`
- C17 compiler environment: `/usr/bin/gcc-14`
- C++17 compiler environment: `/usr/bin/g++-14`
- Current-release forbidden log patterns: none
- Contest error log last modified at 09:51:36 +08:00, before this rollout; no new error entries were added during acceptance or promotion
- Nginx error log: zero bytes
- No compiler-not-found, wrong-profile, fallback-compiler, stuck-submission, SSE-error, `SYSTEM_ERROR`, or uncaught-exception entry was produced
- SQLite integrity: `ok`; in-flight submissions: 0

Result: **CLEAN**

## Issues found and corrected before enablement

1. The pre-existing Judge adapter had no production isolation boundary. A fail-closed systemd sandbox was implemented and verified before any global enablement.
2. The first sandbox canary smoke exposed a null compiler-evidence lookup. The candidate was rolled back, corrected, and retested before submissions continued.
3. The first API AC test source used 32-bit integers despite the problem allowing sums above 32-bit range. The test-only source was corrected to 64-bit and the complete nine-case matrix was rerun successfully.
4. Real-browser inspection exposed a profile initialization-order bug that initially disabled the C11 button. It was fixed, covered by a regression test, deployed to a new canary, and all six language/environment transitions were verified.
5. A stale Runtime Info sentence inaccurately described Official Judge as unconstrained. It was corrected to describe the enforced systemd sandbox and verified in the final release.

None of these remains a blocking failure. No real contest or non-test scoreboard was used.
