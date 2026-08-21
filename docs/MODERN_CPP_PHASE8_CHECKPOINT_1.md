# Modern C/C++ Phase 8 — Checkpoint 1 Engineering Evidence

> **Document state:** Checkpoint 1 complete; clean A/B reproducibility,
> publication, final M1–M7, and local-preview activation passed.
>
> **Evidence snapshot:** `compat-tests/c17/modern-cpp-phase8-e2e.json`, generated
> `2026-08-21T13:44:48.109Z`, against the final published runtime in
> `server/public/js/runtime/cpp-modern-engine-v1/`.
>
> This document does not activate Formal Submit, C++20, C++23, or a stable
> profile. The engine manifest remains `EXPERIMENTAL_CANDIDATE`, its
> `reproducibleBuild` field is `PASS`, and the public C17/C++17 profiles are
> `EXPERIMENTAL / LOCAL_PREVIEW`.

## 1. Gate status and scope

The browser functional gate passed for the final A/B-identical publication:

| Gate | Result | Evidence |
|---|---|---|
| M1 pins and engine ID | PASS | LLVM/Clang/LLD 19.1.7, Emscripten 5.0.2, wasi-libc pin, `wasm32-unknown-wasi` |
| M2 published bytes and SHA-256 | PASS | 18 manifest assets, all same-origin bytes and hashes matched |
| M3 Chrome WASM/glue instantiation | PASS | `WebAssembly.compile`, Emscripten factories, `FS`, `PROXYFS`, `callMain` |
| M4 worker READY/sysroot | PASS | worker READY; 1,621 sysroot files and required headers/libraries/CRT present |
| M5 functional checkpoint | PASS | C17 A+B, C++17 HelloWorld, C++17 A+B |
| M6 cache | PASS | miss, same-source/different-stdin hit, zero compile/link on hit, mutated-source miss |
| M7 browser/no-upload boundary | PASS | no source-like request, no submission request |

The report contains 16/16 PASS cases and `blockingFailures: 0`. Two clean
builds were compared, the selected build was installed, and the final raw
manifest hash was revalidated by M1, M2, and worker evidence.

### Finalization results

| Field | Current value | Rule |
|---|---|---|
| Final `runtimeAssetHash` | `25433ade343cb3e2e3a3255c5a26ffc600b659d26d296749c33ac34d1afaff3c` | SHA-256 of all 6,357 raw bytes of the final installed `runtime-manifest.json` |
| Reproducible Build | **PASS** | `Reproducible Build: PASS (20 assets byte-identical)` |
| Formal Submit | **DISABLED** | Experimental/local preview evidence is not a submit authorization |
| C++20 / C++23 | **PENDING** | Not implemented or executed in Checkpoint 1 |

The earlier smoke-run raw manifest SHA-256 was
`1f55f3154e01cfe9586d0aebe1ce7065bd41ba1aba2762dcff6f184f81e53ab2`;
it was superseded by the final PASS manifest and is retained only as diagnostic
evidence for the stack-size fix.

## 2. Pinned build inputs and runtime architecture

| Component | Actual pin/evidence |
|---|---|
| Runtime ID | `cpp-modern-engine-v1` |
| Profiles | `c17-gcc14-compat-v1` (`-std=c17`), `cpp17-gcc14-compat-v1` (`-std=c++17`) |
| LLVM/Clang/LLD/libc++/libc++abi/compiler-rt | `llvmorg-19.1.7`, requested commit `f34bba6980332ba9447397fc8bd8a0951b224747` |
| Resolved LLVM commit in the A manifest | `cd708029e0b2869e80abe31ddb175f7c35361f90` |
| Emscripten | `5.0.2`, commit `c817c0ca4ba889ee24a185fd954cff7de1bd8afa` |
| Emscripten image digest | `sha256:559781dfc5570c6670d74930a04dfe131cff611b4088761662493d537b87976d` |
| wasi-libc | `574b88da481569b65a237cb80daf9a2d5aeaf82d` |
| Target | `wasm32-unknown-wasi` |
| Build strategy | Native host tablegen + Emscripten cross-build; integrated `cc1`; independent browser `clang.wasm` and `wasm-ld.wasm` |
| Browser memory build settings | 256 MiB initial, 1 GiB maximum, growth enabled, threads disabled, 32 MiB stack |

WASI SDK is a sysroot/build-input reference only. Its native `clang` is not
used as the browser compiler. The published browser toolchain is Emscripten
glue plus the two independently instantiated WASM modules.

The worker protocol remains `init`, `compile`, `run`, `stats`, and `dispose`.
Compiler/linker initialization validates same-origin assets, hashes, glue
exports, WASM instantiation, sysroot mounting, and PROXYFS. Submission
execution uses a fresh isolated WASI instance after the artifact is linked.

The artifact cache key is:

```text
engineRuntimeId + profileId + standard + flags + runtimeAssetHash + sourceHash
```

The effective optimization level is included in `flags`; stdin is deliberately
excluded. The worker keeps the verified asset bytes and unpacked sysroot
resident. Each cache miss creates a fresh Clang/LLD Emscripten pair, writes the
shared sysroot snapshot to Clang FS, mounts LLD through PROXYFS, compiles and
links one submission, then unmounts/releases that pair. A cache hit creates no
compiler/linker pair and reports `compileMs: 0`, `linkMs: 0`.

## 3. Final published asset evidence

The following are the exact final bytes and SHA-256 values observed by M2 after
the A/B-identical build was installed.

| Published file | Bytes | SHA-256 |
|---|---:|---|
| `clang.wasm` | 54,726,610 | `6c4cb1d7c07d4f6945d7cfae776df47b4484cc45f29f6947c01b27fe73e2de60` |
| `wasm-ld.wasm` | 29,051,596 | `5c02391235687229abba6b181062f8efe7e5222d8957b8db7eba2ab10839f429` |
| `clang.js` | 78,609 | `5e520da4e6d036ea0b9c1153fe12cac3f009a85941ba14f16a8891789dad3160` |
| `wasm-ld.js` | 76,348 | `302d625c255cb9b3df78390272e9e6bf88b4d89c0790fa2130024d370ae6f419` |
| `sysroot.tar` | 21,258,240 | `29a6e2b0ff6a52539db02d42df05bf6488759d795fa3bc0fcb6586b3debd340d` |
| `loader.mjs` | 1,454 | `3619a3e1eee6b94b778993cd829e56a03d97ff7feb72b5ed12376c791039016f` |
| `LICENSE` | 395 | `8da54a81b77b03b2d47653979fb0aa9a49b49fa0074ada3ad9dd29407e654181` |
| `THIRD_PARTY_LICENSE_MATRIX.md` | 1,226 | `f9bd285fa3921d1a3e0869c86b10a9a1754506efe2b7940d3f1175150d82dcee` |
| `THIRD_PARTY_NOTICES.md` | 122,559 | `73bf39df0f0dc6046822cf23e8e655c53a5b0453b7a090d54a74b18034c4a957` |
| `licenses/compiler-rt-LICENSE.TXT` | 16,708 | `1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d` |
| `licenses/emscripten-LICENSE` | 5,093 | `620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86` |
| `licenses/emscripten-compiler-rt-LICENSE.TXT` | 16,708 | `1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d` |
| `licenses/emscripten-libcxx-LICENSE.TXT` | 16,703 | `539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b` |
| `licenses/emscripten-libcxxabi-LICENSE.TXT` | 16,706 | `e2b35be49f7284a45b7baca8fc7b3ab7440e7902392b2528a457816b5bb2a15c` |
| `licenses/libcxx-LICENSE.TXT` | 16,703 | `539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b` |
| `licenses/libcxxabi-LICENSE.TXT` | 16,706 | `e2b35be49f7284a45b7baca8fc7b3ab7440e7902392b2528a457816b5bb2a15c` |
| `licenses/llvm-LICENSE.TXT` | 15,141 | `8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee` |
| `licenses/wasi-libc-LICENSE` | 910 | `2711a8b5a5cdfef0e639f96c1aca12ae23d7d64a02d0507f1bdf14d2b27bbc3a` |

The five execution assets (`clang.wasm`, `wasm-ld.wasm`, both glue files,
and `sysroot.tar`) total 105,191,403 raw bytes. All 18 declared assets total
105,438,415 raw bytes. M2 verified every declared file's byte length and
SHA-256 against the same-origin publication.

## 4. M3/M4 browser and sysroot evidence

Chrome independently compiled and instantiated both WASM modules and loaded
both Emscripten factories:

| Module | WASM compile | Factory instantiate | Exports |
|---|---:|---:|---|
| `clang.wasm` + `clang.js` | 39 ms | 73 ms | `FS`, `PROXYFS`, `callMain` |
| `wasm-ld.wasm` + `wasm-ld.js` | 22 ms | 44 ms | `FS`, `PROXYFS`, `callMain` |

M3 mounted the linker view at `/phase8-shared` with source `clang.FS` and
target `wasm-ld.FS`. The worker uses its own `/shared` mount for the same
PROXYFS contract.

M4 inspected the 21,258,240-byte sysroot archive and found 1,621 files,
including:

- libc++ headers under `include/c++/v1` and `lib/libc++.a`;
- `lib/libc++abi.a`;
- compiler-rt builtins at
  `lib/clang/19.1.7/lib/wasm32-unknown-wasi/libclang_rt.builtins-wasm32.a`;
- startup object `lib/wasm32-wasi/crt1-command.o`;
- resource headers under `lib/clang/19.1.7/include`;
- wasi-libc headers under `include/wasm32-wasi` and `lib/wasm32-wasi/libc.a`.

Worker prewarm returned `READY`; the M4 C17 probe returned `8`, with
`compilerInitMs: 186`, `compileMs: 204`, `linkMs: 29`, and
`executionMs: 1.1`. The M4 wall-clock interval was 2,050 ms.

## 5. Functional evidence

All values below are from the M5/M6 result objects in the report. `executionMs`
is measured after WASM compilation and instantiation, and does not include
compiler initialization, compile, link, or WASM instantiate time.

| Case | Stdout | Compile | Link | Execution | Cache | Result |
|---|---|---:|---:|---:|---|---|
| C17 A+B, `3 5` | `8\n` | 20 ms | 17 ms | 1.1 ms | miss | PASS |
| C++17 HelloWorld | `CPP17_BROWSER_OK\n` | 1,001 ms | 34 ms | 1.0 ms | miss | PASS |
| C++17 A+B, `3 5` | `8\n` | 687 ms | 18 ms | 1.7 ms | miss | PASS |
| M6 first cache run, `3 5` | `8\n` | 595 ms | 20 ms | 1.4 ms | miss | PASS |
| M6 same source, stdin `10 20` | `30\n` | 0 ms | 0 ms | 0.1 ms | hit | PASS |
| M6 explicit hit assertion | `30\n` | **0 ms** | **0 ms** | 0.1 ms | hit | PASS |
| M6 mutated source, stdin `10 20` | `30\n` | 574 ms | 18 ms | 1.6 ms | miss | PASS |
| M7 local C17 run | `8\n` | 0 ms | 0 ms | 0.7 ms | hit | PASS |

Every functional case exercised source → `clang.wasm` → object →
`wasm-ld.wasm` → `submission.wasm` → isolated browser execution on misses.
The M6 hit reused the artifact and only reran the isolated submission.

### Timeout, output, and recovery boundary

The M1–M7 harness did not trigger a timeout; no timeout/recovery result is
represented as a pass here. The worker limits are 1 MiB source, 4 MiB stdin,
and 1 MiB per stdout/stderr stream, with explicit truncation/error fields.
Timeout/recovery and broader negative/error compatibility remain outside this
Checkpoint 1 corpus and are blockers for later BETA/compatibility claims.

## 6. Network and performance evidence

The M7 run-phase request log recorded:

| Metric | Value |
|---|---:|
| Total run-phase requests | 0 |
| Source-like request bodies | 0 |
| Formal submission requests | 0 |
| Non-GET requests | 0 |
| `noUpload` | `true` |

M2/M3 and Chrome resource timing observed only same-origin
`/runtime/cpp-modern-engine-v1/` asset URLs. The report stores transfer,
encoded, and decoded sizes for 31 resource entries; entries repeat because
the harness independently verifies the manifest, modules, and worker. One
first-observation set was:

| Resource | Transfer bytes | Encoded/decoded bytes |
|---|---:|---:|
| runtime manifest | 6,657 | 6,357 / 6,357 |
| `clang.wasm` | 54,726,910 | 54,726,610 / 54,726,610 |
| `wasm-ld.wasm` | 29,051,896 | 29,051,596 / 29,051,596 |
| `clang.js` | 78,909 | 78,609 / 78,609 |
| `wasm-ld.js` | 76,648 | 76,348 / 76,348 |
| `sysroot.tar` | 21,258,540 | 21,258,240 / 21,258,240 |

Modern timing from the same report:

| Metric | Modern final publication |
|---|---:|
| Runtime prewarm wall time | 756 ms |
| Cached prewarm wall time | 125 ms |
| M4 worker init wall interval | 1,886 ms |
| Worker health compiler init | 169 ms |
| Cached worker init wall time | 1,036 ms |
| C17 A+B compile / link / execution | 18 / 11 / 0.8 ms |
| C++17 Hello compile / link / execution | 918 / 25 / 0.8 ms |
| C++17 A+B compile / link / execution | 592 / 19 / 1.6 ms |

For comparison, the frozen legacy Clang 8 assets are 31,214,472-byte
`clang.wasm`, 19,490,094-byte `wasm-ld.wasm`, and 1,786,205-byte
`clang-fs.tar.gz`, totaling 52,490,771 raw bytes. In this run Chrome exposed
the legacy sysroot resource only: cold transfer 1,786,505 bytes (encoded
1,786,205), cached transfer 0 bytes. Legacy compiler-WASM transfer metrics
were not exposed and are `N/A`, not inferred. Legacy benchmark values were
cold 790 ms, cached-cold 831 ms, warm compile 330 ms, warm link 18 ms,
and warm execution 6.2 ms.

## 7. 32 MiB stack and isolated-pair root cause

The initial modern artifact with a smaller stack could instantiate but failed
on libc++ header-heavy C++ compilation with frontend memory/out-of-bounds
traps. The build configuration therefore records a 32 MiB stack, which is
needed for Clang 19 to parse the pinned `<iostream>` path.

The 32 MiB stack smoke artifact allowed a fresh-worker C++17 HelloWorld run to
pass. A separate sequence then exposed a second, independent failure: after
reusing the same Emscripten `callMain` compiler/linker instances across C and
C++ submissions, compile/link returned successfully but the linked
`submission.wasm` failed Chrome validation with errors such as:

```text
WebAssembly.compile(): Compiling function __wasm_call_ctors failed:
not enough arguments on the stack
```

This was instance-global LLVM/LLD state contamination, not an asset hash or
sysroot failure. The worker fix keeps the downloaded glue/WASM bytes and
unpacked sysroot resident but creates a disposable compiler/linker pair for
each cache miss. The final M1–M7 run passed C17, C++17 HelloWorld, C++17 A+B,
and repeated cache/mutated-source cases with this isolation model.

## 8. GCC14 reference configuration

The versioned GCC14 reference is specified by `scripts/setup-gcc14.sh`:

```text
GCC14_PIN_VERSION=14.2.0-4ubuntu2~24.04.1
/usr/bin/gcc-14
/usr/bin/g++-14
```

The script verifies both command paths, prints their versions, emits
`GCC14_REFERENCE_READY`, and explicitly does not change the default
`gcc`/`g++` alternatives or the frozen GCC11 commands. The public profile
metadata records GCC/G++ 14.2.0 as the official reference:

| Profile | Reference command | Public submit state |
|---|---|---|
| `c17-gcc14-compat-v1` | `gcc-14 -O2 -std=c17 <src> -lm -o <out>` | disabled |
| `cpp17-gcc14-compat-v1` | `g++-14 -O2 -std=c++17 <src> -o <out>` | disabled |

The deployment gate confirmed `/usr/bin/gcc-14` and `/usr/bin/g++-14` report
14.2.0; `/usr/bin/gcc-11` and `/usr/bin/g++-11` remain 11.5.0, the system
defaults remain unchanged, and legacy judge compiler paths still select GCC11.

## 9. License and redistribution boundary

The engineering inventory in
`server/public/js/runtime/cpp-modern-engine-v1/THIRD_PARTY_LICENSE_MATRIX.md`
and `THIRD_PARTY_NOTICES.md` covers the actual published components:

| Component | Preliminary engineering conclusion |
|---|---|
| LLVM support, Clang, LLD, libc++, libc++abi, compiler-rt 19.1.7 | Apache-2.0 with LLVM Exceptions; preliminary inventory |
| wasi-libc | Apache-2.0/component notices; preliminary inventory |
| Emscripten SDK and generated FS/PROXYFS glue | MIT/upstream notices; preliminary inventory |
| Published notices and license files | Included and hash-checked in M2 |

This is an engineering conclusion only. It is not legal approval, a
redistribution grant, or a `redistributable=true` decision. Legal review is
pending, and Formal Submit remains disabled.

## 10. Java freeze and shared-layer reference

The shared runtime baseline includes the completed Java 21 freeze documented
in [runtime-freeze-java21-v2.md](runtime-freeze-java21-v2.md):

- Runtime `java21-browserjdk-compat-v2`, Browser Local `BETA_FROZEN`, Official
  Judge OpenJDK 21 Stable.
- OpenJDK `21.0.10+7`, upstream commit
  `97a3d2372d457c5a72413df14bf08cf99545c695`, Emscripten 5.0.2 with the same
  pinned image digest, and `BJOJ/1` including the `BJOJ/1 stdin ring contract`.
- Immutable v2 runtime manifest raw-byte hash
  `eee8298d267c2ba781cc6db4d587e6a8a2a39ff8aac5692f1c3a3d01daee5878`;
  seven asset bytes/hashes unchanged.
- Java technical validation and engineering redistribution readiness passed;
  legal review is required and `redistributable=false` remains in force.
- Freeze evidence includes 38 positive and 8 error compatibility cases,
  IO/cache/isolation/timeout regressions, Chrome 16/16 E2E, network isolation,
  500 different-source and 1,000 same-source/different-stdin stress runs, and
  C11/C++11/Python frozen regressions.

The Java freeze is a shared-layer prerequisite and is not changed by this
Modern C/C++ checkpoint.

## 11. Remaining later-phase gates

Checkpoint 1 has no activation blocker. Before any BETA or Formal Submit claim,
the later compatibility, negative/error matrix, corpus, broader E2E, and legal
review gates must still pass. Formal Submit remains disabled in both the UI and
judge allowlist.

Checkpoint 1 deliberately does not implement `bits/stdc++.h` shim/PCH,
negative matrix, 30-case corpus, C++20, or C++23.

`MODERN_CPP_MILESTONE_1`

`MODERN_CPP_PHASE8_CHECKPOINT_1`
