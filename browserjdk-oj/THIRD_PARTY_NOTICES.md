# Third-party notices

This file describes the components deliberately included in the BrowserJDK
build. Exact commits and cryptographic identities are in `PINNED_SOURCES.env`
and the generated runtime/source manifests.

## OpenJDK 21.0.10+7

Copyright (c) Oracle and/or its affiliates and other contributors.

Repository: `https://github.com/openjdk/jdk21u.git`  
Base commit: `97a3d2372d457c5a72413df14bf08cf99545c695`  
Emscripten/Zero port commit: `e339656cdd1c9e09aaf1c4ca9a87c399e3df56a7`
Port author: Brian Martin `<brian.m.martin@oracle.com>`; source is the pinned
`bmarti44/openjdk` commit above. The generated runtime and source-bundle
manifests record the exact binary patch SHA-256.

OpenJDK is GPLv2. The Classpath Exception applies only to source files whose
license headers identify it. The complete upstream license is shipped in the
generated `LICENSE` and in the corresponding source bundle. Ported files keep
their upstream per-file headers and commit authorship.

## Emscripten SDK 5.0.2, LLVM and linked system libraries

Emscripten commit: `c817c0ca4ba889ee24a185fd954cff7de1bd8afa`.

Emscripten's own code is available under the MIT license and the University of
Illinois/NCSA Open Source License. LLVM system library components retain their
respective upstream notices. The final build records the real linker map as
`browserjdk.link.map`; it is the authoritative list of actually linked system
archives. The generated notice bundle appends the pinned toolchain's original
compiler-rt, musl, libc++, libc++abi and libunwind license/copyright files.

## libffi 3.4.6

Copyright (c) 1996-2024 Anthony Green, Red Hat, Inc., and contributors.

Repository: `https://github.com/libffi/libffi.git`  
Base commit: `3d0ce1e6fcf19f853894862abcbac0ae78a7be60`  
WASM port commit: `0b72a27b7cd647eb31f15144dcfeacde864de9f1`
Port author: Brian Martin `<brian.m.martin@oracle.com>`; source is the pinned
`bmarti44/libffi-emscripten` commit above. The generated runtime and
source-bundle manifests record the exact binary patch SHA-256.

libffi uses its permissive MIT-style license. Its copyright and permission
notice from the pinned source tree must be retained. libffi is not described as
LGPL by this project.

## BrowserJDK compatibility patch

`patches/libffi-autoconf-2.72.patch` is an original build-compatibility patch
by Mini-OJ contributors. It is distributed under the same permissive terms as
the libffi `configure.ac` it modifies and is included in the corresponding
source bundle. The generated runtime manifest records its SHA-256 together
with the OpenJDK and libffi port-diff SHA-256 values.

## zlib 1.3.1 embedded by OpenJDK

The generated link map confirms that OpenJDK's `libzip.a` contributes zlib
1.3.1 objects to the WebAssembly binary. The corresponding source is vendored
at `src/java.base/share/native/libzip/zlib` in the pinned OpenJDK source tree.
It carries OpenJDK per-file headers where present and the following zlib notice:

Copyright (C) 1995-2024 Jean-loup Gailly and Mark Adler.

This software is provided 'as-is', without any express or implied warranty.
In no event will the authors be held liable for any damages arising from the
use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it freely,
subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a product,
   an acknowledgment in the product documentation would be appreciated but is
   not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

`browserjdk.link.map` and `LINKED_COMPONENTS.json` remain the source of truth
for every other linked component; notices are appended from the exact pinned
toolchain during the build.

## Excluded JavaBox material

No JavaBox root-repository source, loader, CompileServer, build script, or
prebuilt binary is copied or linked. JavaBox is mentioned only as historical
technical reference; it is not a production runtime dependency.
