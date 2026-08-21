# Third-party license matrix — Phase 7 A14 engineering gate

Overall engineering result remains `CLEAR_WITH_OBLIGATIONS`. This matrix is
generated from the pinned build inputs, `browserjdk.link.map`, the preloaded
runtime data, and `LINKED_COMPONENTS.json`; it is not a legal approval.

| Component | Repository / exact commit | License | Files included in distribution | Modified? | Statically linked? | Bundled? | Redistributed? | Source required? | Notice required? | Obligation | Engineering status |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|
| OpenJDK 21.0.10+7 (Zero JVM, Java base/compiler image) | `openjdk/jdk21u@97a3d2372d457c5a72413df14bf08cf99545c695` + `bmarti44/openjdk@e339656cdd1c9e09aaf1c4ca9a87c399e3df56a7` | GPLv2; Classpath Exception only for files whose own header grants it | `libjvm.a`, `libjava.a`, `libjimage.a`, `libnio.a`, `libzip.a`; jlink image in `browserjdk.data` | Yes | Yes | Yes | Yes | Yes | Yes | Preserve per-file terms; ship GPLv2 text, notices, exact upstream source and complete port diff | CLEAR_WITH_OBLIGATIONS |
| zlib 1.3.1 embedded by OpenJDK | vendored under the pinned OpenJDK commit above (`src/java.base/share/native/libzip/zlib`) | zlib license, with OpenJDK per-file GPLv2/Classpath headers where present | zlib objects inside `libzip.a` (confirmed by `browserjdk.link.map`) | No project modification | Yes, inside `libzip.a` | Yes | Yes | Included in corresponding OpenJDK source | Yes | Retain zlib copyright and permission notice; do not misrepresent origin or modified versions | CLEAR_WITH_OBLIGATIONS |
| libffi 3.4.6 WASM port | `libffi/libffi@3d0ce1e6fcf19f853894862abcbac0ae78a7be60` + `bmarti44/libffi-emscripten@0b72a27b7cd647eb31f15144dcfeacde864de9f1` | permissive MIT-style libffi license | `libffi.a` | Yes | Yes | Yes | Yes | Project gate requires exact source and port diff | Yes | Retain license/copyright; ship exact source, port diff and compatibility patch | CLEAR_WITH_OBLIGATIONS |
| Emscripten generated runtime/system glue | `emscripten-core/emscripten@c817c0ca4ba889ee24a185fd954cff7de1bd8afa` (SDK 5.0.2 image digest `sha256:559781dfc5570c6670d74930a04dfe131cff611b4088761662493d537b87976d`) | Emscripten MIT and UIUC/NCSA notices | generated `browserjdk.mjs`; `libdlmalloc-mt.a`, `libnoexit.a`, `libstubs.a` in `browserjdk.wasm` | No project modification | Yes | Yes | Yes | No copyleft source requirement | Yes | Retain Emscripten and incorporated system-code notices | CLEAR_WITH_OBLIGATIONS |
| musl libc/socket portions supplied by Emscripten | same pinned Emscripten SDK input | MIT plus component copyright notices | `libc-mt.a`, `libsockets-mt.a` | No project modification | Yes | Yes | Yes | No | Yes | Retain musl copyright and license text | CLEAR_WITH_OBLIGATIONS |
| LLVM compiler-rt | same pinned Emscripten SDK input | Apache-2.0 WITH LLVM-exception | `libcompiler_rt-legacysjlj-mt.a` | No project modification | Yes | Yes | Yes | No | Yes | Retain license, notices and LLVM exception | CLEAR_WITH_OBLIGATIONS |
| LLVM libc++ / libc++abi / libunwind | same pinned Emscripten SDK input | Apache-2.0 WITH LLVM-exception | `libc++-mt-legacyexcept.a`, `libc++abi-mt-legacyexcept.a`, `libunwind-mt-legacyexcept.a` | No project modification | Yes | Yes | Yes | No | Yes | Retain each component license and LLVM exception | CLEAR_WITH_OBLIGATIONS |
| BrowserJDK native and Java glue | this source distribution | GPLv2 with the project-granted Classpath Exception | `browserjdk_main.c` in `browserjdk.wasm`; `CompileServer.class` in `browserjdk.data` | Yes | Native: yes; Java: preloaded | Yes | Yes | Yes | Yes | Publish exact corresponding project source and GPLv2/Classpath terms | CLEAR_WITH_OBLIGATIONS |
| Independent JavaScript OJ adapter | this source distribution | MIT | separate `loader.mjs` module | Yes | No | Yes | Yes | No | Yes | Retain project MIT notice; do not describe it as part of OpenJDK | CLEAR |
| JavaBox code, glue, binary and CDN assets | excluded | N/A | none | No | No | No | No | No | No | Keep excluded; no runtime or network dependency may be introduced | CLEAR (EXCLUDED) |

The exact linked archive inventory is generated for every build. For the
current baseline it contains:

`libc++-mt-legacyexcept.a`, `libc++abi-mt-legacyexcept.a`, `libc-mt.a`,
`libcompiler_rt-legacysjlj-mt.a`, `libdlmalloc-mt.a`, `libffi.a`, `libjava.a`,
`libjimage.a`, `libjvm.a`, `libnio.a`, `libnoexit.a`, `libsockets-mt.a`,
`libstubs.a`, `libunwind-mt-legacyexcept.a`, and `libzip.a`.

Release obligations:

- ship the complete GPLv2/Classpath and permissive notices with the runtime;
- publish the matching source bundle or otherwise satisfy GPLv2 source terms;
- retain exact commits, port authorship and patch hashes;
- regenerate this matrix and the linked inventory after any binary change;
- obtain project-owner/legal review before changing `REDISTRIBUTABLE`.

Even when the engineering gate passes, the required state is
`LEGAL_REVIEW_REQUIRED=true` and `REDISTRIBUTABLE=false`.
