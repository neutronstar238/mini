# Third-party license matrix

| Component | Pinned input | License / notice | Published use | Review |
|---|---|---|---|---|
| LLVM support | LLVM 19.1.7 | Apache-2.0 WITH LLVM-exception | clang/lld runtime | Preliminary |
| Clang | LLVM 19.1.7 | Apache-2.0 WITH LLVM-exception | `clang.wasm` | Preliminary |
| LLD | LLVM 19.1.7 | Apache-2.0 WITH LLVM-exception | `wasm-ld.wasm` | Preliminary |
| libc++ | LLVM 19.1.7 | Apache-2.0 WITH LLVM-exception | C++ headers/archive | Preliminary |
| libc++abi | LLVM 19.1.7 | Apache-2.0 WITH LLVM-exception | C++ ABI archive | Preliminary |
| compiler-rt | LLVM 19.1.7 | Apache-2.0 WITH LLVM-exception | builtins archive | Preliminary |
| wasi-libc | `574b88da...` | Apache-2.0 and component notices | sysroot | Preliminary |
| Emscripten SDK | 5.0.2 / `c817c0...` | MIT and upstream notices | build/link toolchain and generated Worker glue | Preliminary |
| Emscripten FS/PROXYFS | 5.0.2 / `c817c0...` | MIT (Emscripten notice included) | linked into `clang.js` and `wasm-ld.js`; shared in-memory VFS | Preliminary |

This matrix is an engineering inventory, not a legal approval or a
redistribution grant. The generated manifest records the exact linked files
and hashes for review.
