# Building `cpp-modern-engine-v1`

## Inputs

All source and toolchain pins are in `PINNED_SOURCES.env`. The Docker image
reference is pinned to Emscripten 5.0.2 image digest
`sha256:559781dfc5570c6670d74930a04dfe131cff611b4088761662493d537b87976d`.
If Docker cannot resolve the registry digest, a locally cached image with the
same Emscripten version may be supplied only for an explicitly recorded
engineering attempt; the manifest retains the requested immutable digest and
records the actual image ID supplied by the wrapper. Such a run is not a
release build until the image ID is reconciled with the pinned digest.

The implementation follows [LLVM upstream llvmorg-19.1.7](https://github.com/llvm/llvm-project/tree/llvmorg-19.1.7).
[WASI SDK](https://github.com/WebAssembly/wasi-sdk) is used only as a
sysroot/build-input reference; a native WASI SDK `clang` is never the browser
compiler. [Emception](https://github.com/jprendes/emception) is retained as a
browser-WASM LLVM feasibility reference.

## Build

From the repository root:

```powershell
pwsh -File modern-clang-oj/scripts/build-modern-clang.ps1 -Clean
```

or from Linux/WSL:

```bash
./modern-clang-oj/scripts/build-modern-clang.sh --clean
```

The build performs the following stages:

1. Verify the pinned LLVM and wasi-libc commits.
2. Build native LLVM/Clang tablegen tools (host-only; never published).
3. Cross-build Clang 19 and LLD 19 with Emscripten for `wasm32-unknown-wasi`.
4. Build the pinned wasi-libc sysroot and LLVM libc++/libc++abi archives.
5. Package a shared sysroot, independent `clang.wasm`/`wasm-ld.wasm`, and
   their pinned Emscripten Worker glue with `FS`/`PROXYFS`/`callMain` exports.
6. Validate WebAssembly magic/version/imports and record bytes/SHA-256.

The pinned Emscripten 5.0.2 toolchain identifies its frontend as Clang 22,
while the pinned wasi-libc commit's expected predefined-macro fixture was
recorded with Clang 20. The build applies
`patches/wasi-libc-clang22-predefined-macros.patch` only to that verification
fixture. The patch adds the eleven macros emitted by Clang 22, changes no
wasi-libc runtime source, must apply cleanly to the pinned commit, and its
SHA-256 is recorded in the generated runtime manifest.

`BUILD_JOBS` controls parallelism. `BUILD_ROOT` can point to a persistent
cache outside the repository. Published output is copied to
`server/public/js/runtime/cpp-modern-engine-v1` by default.

## Reproducibility

Run two clean builds into separate output directories and compare them:

```bash
./modern-clang-oj/scripts/build-modern-clang.sh --clean --out /out/a
./modern-clang-oj/scripts/build-modern-clang.sh --clean --out /out/b
./modern-clang-oj/scripts/verify-reproducible-builds.sh /out/a /out/b
```

The verifier fails on a manifest mismatch or any byte mismatch. The build
does not claim reproducibility when the source checkout, image digest, or
published asset differs.

The browser modules use a pinned 256 MiB initial memory, 1 GiB maximum memory,
memory growth, no threads, and a 32 MiB stack. The explicit stack size is
required for Clang 19 to parse the pinned libc++ `<iostream>` headers without
overflowing Emscripten's small default stack.

## Verify and install

Verify a completed output before publication:

```bash
./modern-clang-oj/scripts/verify-runtime.sh modern-clang-oj/out
```

Install only into the dedicated modern engine directory (the frozen legacy
runtime is never touched):

```bash
./modern-clang-oj/scripts/install-runtime.sh \
  modern-clang-oj/out server/public/js/runtime/cpp-modern-engine-v1
```

## Failure evidence

Every build writes `build.log`, `build-metadata.json`, and
`build-failure.json` (on failure). The failure record names the exact phase,
command, exit code, and tail of the log so a blocked layer remains actionable.
