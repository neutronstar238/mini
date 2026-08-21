# Modern Clang Browser Engine

This directory contains the pinned, self-hosted Phase 8 build for
`cpp-modern-engine-v1`. It emits two independent browser WebAssembly
executables (`clang.wasm` and `wasm-ld.wasm`) from LLVM/Clang/LLD 19.1.7.

The build never uses a native WASI SDK compiler as the browser compiler. A
native host build is used only for LLVM tablegen tools; the published compiler
and linker are Emscripten-cross-built WebAssembly modules. Their pinned Worker
glue exposes `FS`, `PROXYFS`, and `callMain`; Clang owns the in-memory sysroot
and LLD mounts the same VFS through PROXYFS. Submission output remains a
separate `wasm32-unknown-wasi` program executed in an isolated WASI instance.

The repository intentionally keeps downloaded source and intermediate build
trees out of version control. See `BUILDING.md` for exact commands and
`runtime-manifest.json` for the current artifact inventory.

Engineering references:

* [LLVM upstream llvmorg-19.1.7](https://github.com/llvm/llvm-project/tree/llvmorg-19.1.7)
* [WASI SDK](https://github.com/WebAssembly/wasi-sdk) — sysroot/build-input
  reference only; its native `clang` is never published as the browser compiler.
* [Emception](https://github.com/jprendes/emception) — reference for running
  LLVM-family tooling compiled to browser WebAssembly.
