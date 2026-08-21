# Third-party notices

The engine is built from the following pinned upstream projects:

* LLVM, Clang, LLD, libc++, libc++abi, and compiler-rt 19.1.7 at
  `f34bba6980332ba9447397fc8bd8a0951b224747` — Apache License 2.0 with LLVM
  Exceptions.
* wasi-libc at `574b88da481569b65a237cb80daf9a2d5aeaf82d` — Apache License 2.0
  with LLVM Exceptions and component notices included by the source tree.
* Emscripten SDK 5.0.2 at `c817c0ca4ba889ee24a185fd954cff7de1bd8afa` — MIT
  license; the SDK is a build tool and is not used as a published native
  compiler. Generated Worker glue, including FS/PROXYFS support, is published
  beside the two independent WebAssembly modules.

The full license texts and notices for the linked components are copied into
the generated `THIRD_PARTY_NOTICES.md` by the build script when available.
Legal review remains required before redistribution.
