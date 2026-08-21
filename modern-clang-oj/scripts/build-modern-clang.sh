#!/usr/bin/env bash
set -Eeuo pipefail

# Build LLVM/Clang/LLD 19.1.7 as independent browser Worker modules using the
# pinned Emscripten SDK and shared PROXYFS. A native host build is used only
# for tablegen; no native compiler is copied to the runtime output.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="${SRC_DIR:-$ROOT/src}"
BUILD_ROOT="${BUILD_ROOT:-$ROOT/build}"
OUT_DIR="${OUT_DIR:-$ROOT/out}"
PUBLISH_DIR="${PUBLISH_DIR:-/work/repository/server/public/js/runtime/cpp-modern-engine-v1}"
JOBS="${BUILD_JOBS:-$(nproc)}"
LOG_DIR="${LOG_DIR:-$ROOT/logs}"
CLEAN=0
NO_PUBLISH=0

while [[ $# -gt 0 ]]; do
  arg="$1"
  case "$arg" in
    --clean) CLEAN=1 ;;
    --no-publish) NO_PUBLISH=1 ;;
    --out) shift; [[ $# -gt 0 ]] || { echo '--out needs a value' >&2; exit 2; }; OUT_DIR="$1" ;;
    --out=*) OUT_DIR="${arg#*=}" ;;
    --build-root) shift; [[ $# -gt 0 ]] || { echo '--build-root needs a value' >&2; exit 2; }; BUILD_ROOT="$1" ;;
    --build-root=*) BUILD_ROOT="${arg#*=}" ;;
    --publish) shift; [[ $# -gt 0 ]] || { echo '--publish needs a value' >&2; exit 2; }; PUBLISH_DIR="$1" ;;
    --publish=*) PUBLISH_DIR="${arg#*=}" ;;
    --jobs) shift; [[ $# -gt 0 ]] || { echo '--jobs needs a value' >&2; exit 2; }; JOBS="$1" ;;
    --jobs=*) JOBS="${arg#*=}" ;;
    --help|-h)
      sed -n '1,45p' "$0"
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
  shift
done

source "$ROOT/PINNED_SOURCES.env"
export LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH
mkdir -p "$SRC_DIR" "$BUILD_ROOT" "$OUT_DIR" "$LOG_DIR"
LOG_FILE="$LOG_DIR/build.log"
FAILURE_FILE="$LOG_DIR/build-failure.json"
META_FILE="$LOG_DIR/build-metadata.json"
exec > >(tee -a "$LOG_FILE") 2>&1

PHASE=bootstrap
COMMAND=''
write_failure() {
  local status=$?
  python3 - "$FAILURE_FILE" "$PHASE" "$COMMAND" "$status" "$LOG_FILE" <<'PY'
import json, pathlib, sys
path, phase, command, status, log = sys.argv[1:]
body = pathlib.Path(log).read_text(encoding='utf-8', errors='replace') if pathlib.Path(log).exists() else ''
record = {
    'phase': phase,
    'command': command,
    'exitCode': int(status),
    'log': str(pathlib.Path(log)),
    'tail': body[-12000:],
}
pathlib.Path(path).write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PY
}
trap write_failure ERR
run() {
  COMMAND="$*"
  echo "+ $COMMAND"
  "$@"
}
fail() { echo "[modern-clang][fatal][$PHASE] $*" >&2; return 1; }

if [[ "$CLEAN" == 1 ]]; then
  # Only remove this build's explicitly named directories.
  rm -rf "$BUILD_ROOT" "$OUT_DIR"
  mkdir -p "$BUILD_ROOT" "$OUT_DIR"
  # wasi-libc writes generated build/ and sysroot/ directories into its
  # checkout. Reset only this pinned build input so --clean cannot reuse a
  # partially generated sysroot from a failed prior layer.
  if [[ -d "$SRC_DIR/wasi-libc/.git" ]]; then
    run git -C "$SRC_DIR/wasi-libc" checkout --detach "$WASI_LIBC_COMMIT"
    run git -C "$SRC_DIR/wasi-libc" clean -fdx -- build sysroot
  fi
fi

PHASE=verify-toolchain
command -v git >/dev/null || fail 'git is required'
command -v cmake >/dev/null || fail 'cmake is required'
command -v emcc >/dev/null || fail 'emcc is required (run inside the pinned Emscripten image)'
command -v em++ >/dev/null || fail 'em++ is required (run inside the pinned Emscripten image)'
command -v python3 >/dev/null || fail 'python3 is required'
[[ "$(emcc --version | sed -n '1p')" == *"5.0.2"* ]] || fail 'unexpected Emscripten version'
LLVM_ROOT="$(em-config LLVM_ROOT)"
[[ -x "$LLVM_ROOT/clang" ]] || fail "Emscripten LLVM_ROOT has no clang: $LLVM_ROOT"
export PATH="$LLVM_ROOT:$PATH"
HOST_CC="$LLVM_ROOT/clang"
HOST_CXX="$LLVM_ROOT/clang++"
HOST_AR="$LLVM_ROOT/llvm-ar"
HOST_NM="$LLVM_ROOT/llvm-nm"

clone_exact() {
  local url="$1" commit="$2" dir="$3"
  if [[ ! -d "$dir/.git" ]]; then
    rm -rf "$dir"
    run git init -q "$dir"
    run git -C "$dir" remote add origin "$url"
    run git -C "$dir" fetch --filter=blob:none --depth 1 origin "$commit"
  elif ! git -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null; then
    run git -C "$dir" fetch --filter=blob:none --depth 1 origin "$commit"
  fi
  # LLVM's monorepo has a very large test/CI surface. Keep only source trees
  # consumed by this build; sparse checkout does not change the pinned commit.
  if [[ "$dir" == */llvm-project ]]; then
    run git -C "$dir" sparse-checkout init --cone
    run git -C "$dir" sparse-checkout set llvm clang clang-tools-extra lld libcxx libcxxabi compiler-rt runtimes cmake third-party libunwind
  fi
  run git -C "$dir" checkout --detach "$commit"
  local resolved
  resolved="$(git -C "$dir" rev-parse "$commit^{commit}")"
  [[ "$(git -C "$dir" rev-parse HEAD)" == "$resolved" ]] || fail "commit verification failed: $dir (requested=$commit resolved=$resolved)"
}

PHASE=fetch-sources
clone_exact "$LLVM_PROJECT_URL" "$LLVM_PROJECT_COMMIT" "$SRC_DIR/llvm-project"
clone_exact "$WASI_LIBC_URL" "$WASI_LIBC_COMMIT" "$SRC_DIR/wasi-libc"
WASI_MACRO_PATCH="$ROOT/patches/wasi-libc-clang22-predefined-macros.patch"
[[ -f "$WASI_MACRO_PATCH" ]] || fail "required wasi-libc compatibility patch is missing: $WASI_MACRO_PATCH"
if git -C "$SRC_DIR/wasi-libc" apply --check "$WASI_MACRO_PATCH"; then
  run git -C "$SRC_DIR/wasi-libc" apply "$WASI_MACRO_PATCH"
elif git -C "$SRC_DIR/wasi-libc" apply --reverse --check "$WASI_MACRO_PATCH"; then
  echo "+ wasi-libc Clang 22 predefined-macro fixture patch already applied"
else
  fail 'wasi-libc compatibility patch does not apply cleanly to the pinned commit'
fi
LLVM_RESOLVED_COMMIT="$(git -C "$SRC_DIR/llvm-project" rev-parse "$LLVM_PROJECT_COMMIT^{commit}")"
WASI_RESOLVED_COMMIT="$(git -C "$SRC_DIR/wasi-libc" rev-parse "$WASI_LIBC_COMMIT^{commit}")"
WASI_MACRO_PATCH_SHA256="$(sha256sum "$WASI_MACRO_PATCH" | awk '{print $1}')"
export LLVM_RESOLVED_COMMIT WASI_RESOLVED_COMMIT WASI_MACRO_PATCH_SHA256

LLVM_SRC="$SRC_DIR/llvm-project/llvm"
HOST_BUILD="$BUILD_ROOT/host"
WASM_BUILD="$BUILD_ROOT/wasm"
WASI_BUILD="$BUILD_ROOT/wasi-libc"
RUNTIME_BUILD="$BUILD_ROOT/runtimes"
HOST_BIN="$HOST_BUILD/bin"

PHASE=host-tablegen
if [[ ! -x "$HOST_BIN/llvm-tblgen" || ! -x "$HOST_BIN/clang-tblgen" ]]; then
  run cmake -S "$LLVM_SRC" -B "$HOST_BUILD" -G "Unix Makefiles" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER="$HOST_CC" -DCMAKE_CXX_COMPILER="$HOST_CXX" \
    -DLLVM_ENABLE_PROJECTS='clang;lld' \
    -DLLVM_TARGETS_TO_BUILD=Native \
    -DLLVM_BUILD_TOOLS=ON -DLLVM_BUILD_UTILS=ON \
    -DCLANG_BUILD_TOOLS=ON -DCLANG_LINK_CLANG_DYLIB=OFF \
    -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_ZLIB=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF
  run cmake --build "$HOST_BUILD" --target llvm-tblgen clang-tblgen -- -j"$JOBS"
fi
[[ -x "$HOST_BIN/llvm-tblgen" ]] || fail 'llvm-tblgen was not built'
[[ -x "$HOST_BIN/clang-tblgen" ]] || fail 'clang-tblgen was not built'

PHASE=wasm-configure
# Keep link flags explicit. The modules run in a dedicated browser Worker
# through pinned Emscripten glue, whose PROXYFS gives Clang and LLD one VFS.
# Reconfigure incremental builds too, so a pinned flag change cannot silently
# reuse a stale CMake cache; clean reproducibility builds still remove BUILD_ROOT.
export EMCC_CFLAGS='-O2 -fno-exceptions'
export EMXX_CXXFLAGS='-O2 -fno-exceptions'
export EMCC_LDFLAGS='-sWASM_BIGINT=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=1073741824 -sSTACK_SIZE=33554432 -sMODULARIZE=1 -sEXPORT_NAME=createModernModule -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sFORCE_FILESYSTEM=1 -sENVIRONMENT=worker -sEXPORTED_RUNTIME_METHODS=FS,PROXYFS,callMain -lproxyfs.js'
run emcmake cmake -S "$LLVM_SRC" -B "$WASM_BUILD" -G "Unix Makefiles" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER=emcc -DCMAKE_CXX_COMPILER=em++ \
    -DCMAKE_AR=emar -DCMAKE_RANLIB=emranlib \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCMAKE_EXECUTABLE_SUFFIX=.wasm \
    -DCMAKE_EXE_LINKER_FLAGS='-sWASM_BIGINT=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=1073741824 -sSTACK_SIZE=33554432 -sMODULARIZE=1 -sEXPORT_NAME=createModernModule -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sFORCE_FILESYSTEM=1 -sENVIRONMENT=worker -sEXPORTED_RUNTIME_METHODS=FS,PROXYFS,callMain -lproxyfs.js' \
    -DLLVM_TABLEGEN="$HOST_BIN/llvm-tblgen" \
    -DCLANG_TABLEGEN="$HOST_BIN/clang-tblgen" \
    -DLLVM_NATIVE_TOOL_DIR="$HOST_BIN" \
    -DLLVM_ENABLE_PROJECTS='clang;lld' \
    -DLLVM_TARGETS_TO_BUILD=WebAssembly \
    -DLLVM_BUILD_TOOLS=ON -DLLVM_BUILD_UTILS=OFF \
    -DCLANG_BUILD_TOOLS=OFF -DCLANG_LINK_CLANG_DYLIB=OFF \
    -DCLANG_ENABLE_ARCMT=OFF -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
    -DCLANG_ENABLE_OBJC_REWRITER=OFF \
    -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_ZLIB=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_ENABLE_BINDINGS=OFF \
  -DLLVM_ENABLE_IDE=OFF

PHASE=wasm-build
run cmake --build "$WASM_BUILD" --target clang lld -- -j"$JOBS"

PHASE=wasi-libc
if [[ ! -d "$WASI_BUILD/sysroot" ]]; then
  mkdir -p "$WASI_BUILD"
  # wasi-libc's documented build uses the active clang/llvm-ar binaries from
  # the Emscripten SDK. The output is data/sysroot only; it is not published
  # as the compiler executable.
  run make -C "$SRC_DIR/wasi-libc" -j"$JOBS" \
    CC="$HOST_CC" AR="$HOST_AR" NM="$HOST_NM" \
    EXTRA_CFLAGS="-O2 -DNDEBUG -Wno-error=deprecated -Wno-error=unterminated-string-initialization" \
    THREAD_MODEL=single
  if [[ -d "$SRC_DIR/wasi-libc/sysroot" ]]; then
    run cp -a "$SRC_DIR/wasi-libc/sysroot" "$WASI_BUILD/"
  elif [[ -d "$SRC_DIR/wasi-libc/build/sysroot" ]]; then
    run cp -a "$SRC_DIR/wasi-libc/build/sysroot" "$WASI_BUILD/"
  else
    fail 'wasi-libc build completed without a sysroot directory'
  fi
fi

PHASE=llvm-runtimes
find_runtime_archive() {
  [[ -d "$RUNTIME_BUILD/install" ]] || return 0
  find "$RUNTIME_BUILD/install" -type f -name "$1" -size +1k | sort | head -n 1
}
LIBCXX_ARCHIVE="$(find_runtime_archive libc++.a)"
LIBCXXABI_ARCHIVE="$(find_runtime_archive libc++abi.a)"
if [[ -z "$LIBCXX_ARCHIVE" || -z "$LIBCXXABI_ARCHIVE" ]]; then
  # Use the raw LLVM Clang from the pinned Emscripten SDK only as a build
  # driver. The runtime archives themselves are explicitly targeted at
  # wasm32-unknown-wasi and use the pinned wasi-libc sysroot; no Emscripten
  # libc++/libc++abi archive is substituted for these components.
  mkdir -p "$RUNTIME_BUILD/install"
  run cmake -S "$SRC_DIR/llvm-project/runtimes" -B "$RUNTIME_BUILD" -G "Unix Makefiles" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSTEM_NAME=Generic -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
    -DCMAKE_C_COMPILER="$HOST_CC" -DCMAKE_CXX_COMPILER="$HOST_CXX" \
    -DCMAKE_AR="$HOST_AR" -DCMAKE_RANLIB="$LLVM_ROOT/llvm-ranlib" -DCMAKE_NM="$HOST_NM" \
    -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-wasi \
    -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown-wasi \
    -DCMAKE_SYSROOT="$WASI_BUILD/sysroot" \
    -DCMAKE_C_FLAGS="--target=wasm32-unknown-wasi --sysroot=$WASI_BUILD/sysroot" \
    -DCMAKE_CXX_FLAGS="--target=wasm32-unknown-wasi --sysroot=$WASI_BUILD/sysroot" \
    -DCMAKE_INSTALL_PREFIX="$RUNTIME_BUILD/install" \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DLLVM_ENABLE_RUNTIMES='libcxx;libcxxabi;compiler-rt' \
    -DLIBCXX_CXX_ABI=libcxxabi -DLIBCXX_CXX_ABI_INCLUDE_PATH="$SRC_DIR/llvm-project/libcxxabi/include" \
    -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXX_ENABLE_STATIC=ON \
    -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_STATIC=ON \
    -DLIBCXXABI_USE_LLVM_UNWINDER=OFF \
    -DLIBCXX_ENABLE_THREADS=OFF -DLIBCXXABI_ENABLE_THREADS=OFF \
    -DLIBCXX_ENABLE_EXCEPTIONS=OFF -DLIBCXXABI_ENABLE_EXCEPTIONS=OFF \
    -DCOMPILER_RT_BUILD_SHARED_LIBS=OFF -DCOMPILER_RT_BUILD_BUILTINS=ON \
    -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON -DCOMPILER_RT_BAREMETAL_BUILD=ON \
    -DCOMPILER_RT_BUILD_SANITIZERS=OFF -DCOMPILER_RT_BUILD_XRAY=OFF \
    -DCOMPILER_RT_BUILD_MEMPROF=OFF -DCOMPILER_RT_BUILD_PROFILE=OFF \
    -DCOMPILER_RT_BUILD_LIBFUZZER=OFF \
    -DLLVM_ENABLE_THREADS=OFF -DLLVM_INCLUDE_TESTS=OFF
  run cmake --build "$RUNTIME_BUILD" --target install -- -j"$JOBS"
fi
LIBCXX_ARCHIVE="$(find_runtime_archive libc++.a)"
LIBCXXABI_ARCHIVE="$(find_runtime_archive libc++abi.a)"
[[ -n "$LIBCXX_ARCHIVE" ]] || fail 'LLVM libc++.a missing after runtimes build'
[[ -n "$LIBCXXABI_ARCHIVE" ]] || fail 'LLVM libc++abi.a missing after runtimes build'
BUILTINS_ARCHIVE="$(find "$RUNTIME_BUILD/install" "$RUNTIME_BUILD" -type f -name 'libclang_rt.builtins*.a' -size +1k | sort | head -n 1)"
[[ -n "$BUILTINS_ARCHIVE" ]] || fail 'compiler-rt builtins archive missing after runtimes build'

PHASE=package
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/sysroot" "$OUT_DIR/licenses"

find_wasm() {
  local name="$1"
  find "$WASM_BUILD" -type f \( -name "$name.wasm" -o -name "$name" \) -size +1k | sort | head -n 1
}
CLANG_WASM="$(find_wasm clang)"
LLD_WASM="$(find_wasm lld)"
[[ -n "$CLANG_WASM" ]] || fail 'clang wasm output missing'
[[ -n "$LLD_WASM" ]] || fail 'lld wasm output missing'
run cp "$CLANG_WASM" "$OUT_DIR/clang.wasm"
run cp "$LLD_WASM" "$OUT_DIR/wasm-ld.wasm"
CLANG_GLUE="$(find "$WASM_BUILD/bin" -maxdepth 1 -type f -name 'clang.js-*' -size +1k | sort | head -n 1)"
LLD_GLUE="$(find "$WASM_BUILD/bin" -maxdepth 1 -type f -name 'lld.js' -size +1k | sort | head -n 1)"
[[ -n "$CLANG_GLUE" ]] || fail 'Emscripten Clang worker glue missing'
[[ -n "$LLD_GLUE" ]] || fail 'Emscripten LLD worker glue missing'
run cp "$CLANG_GLUE" "$OUT_DIR/clang.js"
run cp "$LLD_GLUE" "$OUT_DIR/wasm-ld.js"

# Keep compiler resource headers, wasi-libc, libc++, libc++abi, and compiler-rt
# in a deterministic tree. Every required component is hard-gated below; no
# missing runtime archive is downgraded to an optional/absent state.
RESOURCE_DIR="$(find "$WASM_BUILD/lib/clang" -mindepth 2 -maxdepth 3 -type d -name include | sort | head -n 1)"
if [[ -d "$WASI_BUILD/sysroot" ]]; then run cp -a "$WASI_BUILD/sysroot/." "$OUT_DIR/sysroot/"; fi
run cp -a "$RUNTIME_BUILD/install/." "$OUT_DIR/sysroot/"
run mkdir -p "$OUT_DIR/sysroot/lib/clang/19.1.7"
[[ -n "$RESOURCE_DIR" && -d "$RESOURCE_DIR" ]] || fail 'Clang resource headers missing from cross build'
run cp -a "$RESOURCE_DIR" "$OUT_DIR/sysroot/lib/clang/19.1.7/include"
run mkdir -p "$OUT_DIR/sysroot/lib/wasm32-wasi"
run cp "$LIBCXX_ARCHIVE" "$OUT_DIR/sysroot/lib/wasm32-wasi/libc++.a"
run cp "$LIBCXXABI_ARCHIVE" "$OUT_DIR/sysroot/lib/wasm32-wasi/libc++abi.a"
run mkdir -p "$OUT_DIR/sysroot/lib/clang/19.1.7/lib/wasm32-unknown-wasi"
run cp "$BUILTINS_ARCHIVE" "$OUT_DIR/sysroot/lib/clang/19.1.7/lib/wasm32-unknown-wasi/libclang_rt.builtins-wasm32.a"

# Hard gate required sysroot pieces before creating the published tarball.
CRT1="$(find "$OUT_DIR/sysroot" -type f \( -name crt1.o -o -name crt1-command.o \) -size +100c | sort | head -n 1)"
[[ -n "$CRT1" ]] || fail 'wasi-libc crt1.o/crt1-command.o missing from sysroot'
[[ -d "$OUT_DIR/sysroot/include/c++/v1" ]] || fail 'libc++ headers missing from sysroot'
[[ -d "$OUT_DIR/sysroot/lib/clang/19.1.7/include" ]] || fail 'Clang resource headers missing from sysroot'
[[ -f "$OUT_DIR/sysroot/lib/clang/19.1.7/lib/wasm32-unknown-wasi/libclang_rt.builtins-wasm32.a" ]] || fail 'compiler-rt builtins missing from standard Clang sysroot path'

PHASE=loader
run cp "$ROOT/LICENSE" "$OUT_DIR/LICENSE"
run cp "$ROOT/THIRD_PARTY_LICENSE_MATRIX.md" "$OUT_DIR/THIRD_PARTY_LICENSE_MATRIX.md"
EMSCRIPTEN_ROOT="$(em-config EMSCRIPTEN_ROOT)"
copy_notice() {
  local label="$1" source="$2" destination="$3"
  if [[ -f "$source" ]]; then
    run cp "$source" "$OUT_DIR/licenses/$destination"
    printf '\n\n===== %s =====\n\n' "$label" >> "$OUT_DIR/THIRD_PARTY_NOTICES.md"
    cat "$source" >> "$OUT_DIR/THIRD_PARTY_NOTICES.md"
  fi
}
run cp "$ROOT/THIRD_PARTY_NOTICES.md" "$OUT_DIR/THIRD_PARTY_NOTICES.md"
copy_notice 'LLVM/Clang/LLD 19.1.7' "$SRC_DIR/llvm-project/llvm/LICENSE.TXT" llvm-LICENSE.TXT
copy_notice 'Clang' "$SRC_DIR/llvm-project/clang/LICENSE.txt" clang-LICENSE.txt
copy_notice 'LLD' "$SRC_DIR/llvm-project/lld/LICENSE.txt" lld-LICENSE.txt
copy_notice 'LLVM libc++' "$SRC_DIR/llvm-project/libcxx/LICENSE.TXT" libcxx-LICENSE.TXT
copy_notice 'LLVM libc++abi' "$SRC_DIR/llvm-project/libcxxabi/LICENSE.TXT" libcxxabi-LICENSE.TXT
copy_notice 'LLVM compiler-rt' "$SRC_DIR/llvm-project/compiler-rt/LICENSE.TXT" compiler-rt-LICENSE.TXT
copy_notice 'wasi-libc LICENSE' "$SRC_DIR/wasi-libc/LICENSE" wasi-libc-LICENSE
copy_notice 'wasi-libc COPYRIGHT' "$SRC_DIR/wasi-libc/COPYRIGHT" wasi-libc-COPYRIGHT
copy_notice 'Emscripten SDK' "$EMSCRIPTEN_ROOT/LICENSE" emscripten-LICENSE
copy_notice 'Emscripten compiler-rt' "$EMSCRIPTEN_ROOT/system/lib/compiler-rt/LICENSE.TXT" emscripten-compiler-rt-LICENSE.TXT
copy_notice 'Emscripten libc++' "$EMSCRIPTEN_ROOT/system/lib/libcxx/LICENSE.TXT" emscripten-libcxx-LICENSE.TXT
copy_notice 'Emscripten libc++abi' "$EMSCRIPTEN_ROOT/system/lib/libcxxabi/LICENSE.TXT" emscripten-libcxxabi-LICENSE.TXT
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
  -cf "$OUT_DIR/sysroot.tar" -C "$OUT_DIR/sysroot" .
rm -rf "$OUT_DIR/sysroot"
python3 - "$OUT_DIR" "$ROOT" <<'PY'
import hashlib, json, os, pathlib, shutil, sys, time
out = pathlib.Path(sys.argv[1]); root = pathlib.Path(sys.argv[2])
def sha(p):
    h = hashlib.sha256();
    with p.open('rb') as f:
        for b in iter(lambda: f.read(1024*1024), b''): h.update(b)
    return h.hexdigest()
def tree(root):
    return sorted(str(p.relative_to(root)).replace('\\','/') for p in root.rglob('*') if p.is_file())
files=[]
for p in sorted(out.rglob('*')):
    if p.is_file(): files.append({'file':str(p.relative_to(out)).replace('\\','/'),'bytes':p.stat().st_size,'sha256':sha(p)})
loader = """// Deterministic loader for cpp-modern-engine-v1; same-origin assets only.

export const RUNTIME_ID = 'cpp-modern-engine-v1';
export const TARGET = 'wasm32-unknown-wasi';
export const ASSETS = Object.freeze({ compiler: 'clang.wasm', linker: 'wasm-ld.wasm', sysroot: 'sysroot.tar' });
const base = new URL('./', import.meta.url);
export function assetUrl(name) { return new URL(name, base); }
export async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export async function fetchAsset(name, options = {}) {
  if (!Object.values(ASSETS).includes(name)) throw new Error(`unknown modern runtime asset: ${name}`);
  const response = await fetch(assetUrl(name), { cache: options.cache || 'force-cache' });
  if (!response.ok) throw new Error(`runtime asset ${name} HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (options.expectedSha256) {
    const actual = await sha256(bytes);
    if (actual !== options.expectedSha256) throw new Error(`runtime asset ${name} SHA-256 mismatch`);
  }
  options.onProgress?.({ name, loaded: bytes.byteLength, total: Number(response.headers.get('content-length')) || bytes.byteLength });
  return bytes;
}
export async function instantiateWasi(bytes, imports) {
  const module = await WebAssembly.compile(bytes);
  return WebAssembly.instantiate(module, imports);
}
"""
(out/'loader.mjs').write_text(loader, encoding='utf-8', newline='\n')
files=[]
for p in sorted(out.rglob('*')):
    if p.is_file(): files.append({'file':str(p.relative_to(out)).replace('\\','/'),'bytes':p.stat().st_size,'sha256':sha(p)})
manifest = {
  'runtimeId':'cpp-modern-engine-v1', 'status':'EXPERIMENTAL_CANDIDATE',
  'engineRuntimeId':'cpp-modern-engine-v1', 'target':'wasm32-unknown-wasi',
  'llvm': {'tag':'llvmorg-19.1.7','commit':'f34bba6980332ba9447397fc8bd8a0951b224747','resolvedCommit':os.environ.get('LLVM_RESOLVED_COMMIT','unknown')},
  'emscripten': {'version':'5.0.2','commit':'c817c0ca4ba889ee24a185fd954cff7de1bd8afa','image':'emscripten/emsdk:5.0.2','imageDigest':'sha256:559781dfc5570c6670d74930a04dfe131cff611b4088761662493d537b87976d','imageId':os.environ.get('MODERN_CLANG_IMAGE_ID','not-provided')},
  'wasiLibc': {'commit':'574b88da481569b65a237cb80daf9a2d5aeaf82d','resolvedCommit':os.environ.get('WASI_RESOLVED_COMMIT','unknown')},
  'sourcePatches': [{'file':'patches/wasi-libc-clang22-predefined-macros.patch','sha256':os.environ.get('WASI_MACRO_PATCH_SHA256','unknown'),'purpose':'Update the pinned wasi-libc expected predefined-macro fixture for the pinned Emscripten 5.0.2 Clang 22 frontend; no runtime source is changed.'}],
  'compilerStrategy':'native-host-tablegen + Emscripten cross-build; integrated cc1; dedicated Worker modules with shared PROXYFS/VFS',
  'memory': {'initialBytes':268435456, 'maximumBytes':1073741824, 'stackBytes':33554432, 'growth':True, 'threads':False},
  'profiles': {'c17-gcc14-compat-v1': {'standard':'c17','flags':['-std=c17'],'submissionEnabled':False}, 'cpp17-gcc14-compat-v1': {'standard':'c++17','flags':['-std=c++17'],'submissionEnabled':False}},
  'assets': [
    {'file':'clang.wasm','path':'/runtime/cpp-modern-engine-v1/clang.wasm','kind':'compiler','role':'clang','bytes':next(x['bytes'] for x in files if x['file']=='clang.wasm'),'sha256':next(x['sha256'] for x in files if x['file']=='clang.wasm')},
    {'file':'wasm-ld.wasm','path':'/runtime/cpp-modern-engine-v1/wasm-ld.wasm','kind':'linker','role':'wasm-ld','bytes':next(x['bytes'] for x in files if x['file']=='wasm-ld.wasm'),'sha256':next(x['sha256'] for x in files if x['file']=='wasm-ld.wasm')},
    {'file':'clang.js','path':'/runtime/cpp-modern-engine-v1/clang.js','kind':'compiler-glue','role':'emscripten-worker-glue','bytes':next(x['bytes'] for x in files if x['file']=='clang.js'),'sha256':next(x['sha256'] for x in files if x['file']=='clang.js')},
    {'file':'wasm-ld.js','path':'/runtime/cpp-modern-engine-v1/wasm-ld.js','kind':'linker-glue','role':'emscripten-worker-glue','bytes':next(x['bytes'] for x in files if x['file']=='wasm-ld.js'),'sha256':next(x['sha256'] for x in files if x['file']=='wasm-ld.js')},
    {'file':'sysroot.tar','path':'/runtime/cpp-modern-engine-v1/sysroot.tar','kind':'sysroot','role':'wasi-libc+libc++','bytes':next(x['bytes'] for x in files if x['file']=='sysroot.tar'),'sha256':next(x['sha256'] for x in files if x['file']=='sysroot.tar')},
    {'file':'loader.mjs','path':'/runtime/cpp-modern-engine-v1/loader.mjs','kind':'loader','role':'asset-loader','bytes':next(x['bytes'] for x in files if x['file']=='loader.mjs'),'sha256':next(x['sha256'] for x in files if x['file']=='loader.mjs')},
  ], 'assetInventory': files, 'reproducibleBuild':'PENDING',
  'build': {'sourceDateEpoch': int(os.environ.get('SOURCE_DATE_EPOCH','1770336000')), 'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(int(os.environ.get('SOURCE_DATE_EPOCH','1770336000'))))}
}
(out/'runtime-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,sort_keys=True,indent=2)+'\n',encoding='utf-8')
(out/'asset-index.json').write_text(json.dumps(files,indent=2)+'\n',encoding='utf-8')
PY

PHASE=validate
run python3 - "$OUT_DIR" <<'PY'
import json, pathlib, sys, hashlib
root=pathlib.Path(sys.argv[1]); m=json.loads((root/'runtime-manifest.json').read_text())
assert m['llvm']['commit']=='f34bba6980332ba9447397fc8bd8a0951b224747'
assert m['emscripten']['version']=='5.0.2'
for name in ('clang.wasm','wasm-ld.wasm'):
    p=root/name; b=p.read_bytes(); assert b[:4]==b'\0asm', name
    assert b[4]==1, name
    print(name, len(b), hashlib.sha256(b).hexdigest())
assert (root/'clang.wasm').stat().st_size > 1024*1024
assert (root/'wasm-ld.wasm').stat().st_size > 1024*1024
for name in ('clang.js','wasm-ld.js'):
    text=(root/name).read_text(encoding='utf-8')
    assert 'createModernModule' in text and 'PROXYFS' in text and 'callMain' in text, name
PY

PHASE=publish
if [[ "$NO_PUBLISH" == 0 ]]; then
  rm -rf "$PUBLISH_DIR"
  mkdir -p "$PUBLISH_DIR"
  run cp -a "$OUT_DIR/." "$PUBLISH_DIR/"
fi

PHASE=complete
python3 - "$META_FILE" "$OUT_DIR" <<'PY'
import hashlib, json, pathlib, subprocess, sys
meta, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
record={'status':'PASS','output':str(out),'assets':{str(p.relative_to(out)).replace('\\','/'): {'bytes':p.stat().st_size,'sha256':digest(p)} for p in sorted(out.rglob('*')) if p.is_file()}}
meta.write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
PY
rm -f "$FAILURE_FILE"
echo "MODERN_CLANG_BUILD_COMPLETE"
