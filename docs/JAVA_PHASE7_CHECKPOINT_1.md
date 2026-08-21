# JAVA_PHASE7_CHECKPOINT_1

> Generated: 2026-08-21  
> Scope: Phase 7 Java A1–A6 only  
> Runtime: `java21-browserjdk-compat-v1`  
> State: `TECHNICALLY_VALIDATED=true`, `REDISTRIBUTABLE=false`

## Outcome

The self-built, self-hosted BrowserJDK runtime completed Checkpoint 1. The production Worker loads only the local `loader.mjs`; JavaBox source, build scripts, loader, and prebuilt assets are not part of the build or runtime path. No A7 or Modern C++ work was started.

Two clean Docker builds, each with an empty private work directory and no shared build volume, produced byte-identical manifest assets. A read-only cache containing only the pinned upstream Git objects was used as the source transport. The final runtime passed the real-Chrome IO and ACM suites against Temurin/OpenJDK 21.0.10+7.

## Reproducible assets

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `browserjdk.wasm` | 3,226,551 | `7f2acfac69689859fe6a752c38378b8f472343d2425a7209f1b485023c2dfc4c` |
| `browserjdk.data` | 26,681,737 | `086b4655133d2089be6b5a5922eccb3d2b91b82d3774db2d1ab18168cd6a8498` |
| `browserjdk.mjs` | 142,827 | `6f1fcf0428769dc0f25986079fd87f1da376e4cd88c370a328d6f05f50a17ddc` |
| `loader.mjs` | 7,868 | `02daa0bc7eb8ab056479655a15c820033818444d7e3a522207cfa9807810f956` |
| `LICENSE` | 22,152 | `0e45d00edb6894bccb03203de831668fc4f6e27e92cca5fe35c14b77aec52b6b` |
| `THIRD_PARTY_NOTICES.md` | 82,569 | `245ef0cd2eea82b85263a11084960bf92001bd11a7e9e3e9cfd2c286163adc7c` |
| `LINKED_COMPONENTS.json` | 420 | `92a0c2f22c11321c424b4a92afb478dc6eebe6c9e6f3b7c05315a2f6a55699dd` |
| `runtime-manifest.json` | 2,235 | `4afb4b61d9fd9d293a3bcd98f2908a25c4014c9c4d6be5d53cc40c20f247eaa9` |

The manifest's seven declared assets matched byte-for-byte between the two builds. `runtime-manifest.json` is listed separately because it describes those assets.

## Pinned build inputs

| Input | Pin |
|---|---|
| OpenJDK 21.0.10+7 | `97a3d2372d457c5a72413df14bf08cf99545c695` |
| Emscripten/Zero port | `e339656cdd1c9e09aaf1c4ca9a87c399e3df56a7` |
| libffi 3.4.6 | `3d0ce1e6fcf19f853894862abcbac0ae78a7be60` |
| libffi WASM port | `0b72a27b7cd647eb31f15144dcfeacde864de9f1` |
| Emscripten SDK | `5.0.2`, commit `c817c0ca4ba889ee24a185fd954cff7de1bd8afa` |
| Emscripten image | `sha256:559781dfc5570c6670d74930a04dfe131cff611b4088761662493d537b87976d` |
| Build JDK | Temurin 21.0.10+7 Linux x64, SHA-256 `ea3b9bd464d6dd253e9a7accf59f7ccd2a36e4aa69640b7251e3370caef896a4` |

## Acceptance results

- Chrome: `151.0.7922.170`, localhost with COOP/COEP, production Worker and self-built loader.
- Browser Java: `21.0.10+7-LTS`; server baseline: OpenJDK `21.0.10`.
- JVM READY wall time: `1897 ms` (final verification run).
- HelloWorld: PASS.
- IO suite: `12/12` compatibility and `12/12` correctness.
- ACM corpus: `12/12` compatibility and `12/12` correctness.
- Combined Browser vs Server: `24/24`; deterministic cases also matched Expected.
- Blocking failures for A1–A6: none.

IO cases passed: `scanner_ab`, `scanner_until_eof`, `bufferedreader_ab`, `bufferedreader_until_eof`, `stringtokenizer`, `bufferedinputstream_fastscanner`, `system_in_read`, `empty_input`, `no_trailing_newline`, `large_input_10000`, `unicode`, and `multi_case`.

## Runtime boundary

The shared-memory bridge uses distinct control request, control response, and program-stdin rings. Control frames use `BJOJ/1` with `PING`, `COMPILE_RUN`, and `SHUTDOWN`; CompileServer never consumes `System.in` as control input. Each run resets stdin, sends its control frame, streams UTF-8 input, closes EOF, and waits for the response. Missing or hash-mismatched assets fail closed as `BUILD_REQUIRED / NOT_READY`; there is no JavaBox CDN fallback.

The linked-component inventory is generated from the real linker map. Network and native process surfaces represented by unresolved `NET_*`, `initInetAddressIDs`, process `os_*`, and `sigsuspend` symbols remain outside the A1–A6 OJ boundary. They are not claimed as supported Java SE functionality.

## Licensing and source offer preparation

Engineering status is `CLEAR_WITH_OBLIGATIONS`. OpenJDK files and port patches retain their actual GPLv2/ClassPath Exception headers; the exception is not asserted for files that do not carry it. Emscripten/compiler runtime, musl, libc++, libc++abi, libunwind, libffi, zlib, and other actually linked components are enumerated with their notices. The independent JS OJ adapter is MIT-licensed separately.

The complete source bundle is `browserjdk-oj-source.tar.gz`, 115,182,441 bytes, SHA-256 `3aba2b2e8dde0893be76d926a7fe5eee67650db69d94812f33c02ba41d75fc36`. It contains pinned official upstream sources, attributable port patches, project-owned glue, and build definitions.

This is an engineering compliance result, not legal advice or the final A14 redistribution gate. Project-owner/legal review is still required before public redistribution; therefore `REDISTRIBUTABLE=false`, and no `BETA`, `STABLE`, or `REDIST_OK` claim is made.
