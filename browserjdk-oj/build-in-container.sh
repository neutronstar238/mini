#!/usr/bin/env bash
set -euo pipefail

SRC=/src
OUT="${1:-/out}"
WORK=/work
# shellcheck disable=SC1091
source "$SRC/PINNED_SOURCES.env"
export LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1770336000}"
JOBS="${BROWSERJDK_BUILD_JOBS:-$(nproc)}"
mkdir -p "$OUT" "$WORK/build"

log() { printf '[browserjdk] %s\n' "$*"; }
fail() { printf '[browserjdk][fatal] %s\n' "$*" >&2; exit 1; }

clone_exact() {
  local url="$1" commit="$2" destination="$3"
  if test -d "$destination/.git"; then
    test "$(git -C "$destination" rev-parse HEAD)" = "$commit" || fail "reused workspace has wrong commit: $destination"
    return
  fi
  local cache="${BROWSERJDK_SOURCE_CACHE:-}/$(basename "$destination").git"
  if test -n "${BROWSERJDK_SOURCE_CACHE:-}" && test -f "$cache/HEAD"; then
    log "copying verified source cache: $(basename "$destination")"
    git clone -q --no-hardlinks "$cache" "$destination"
    git -C "$destination" checkout -q --detach "$commit"
    test "$(git -C "$destination" rev-parse HEAD)" = "$commit" || fail "cached commit verification failed: $destination"
    return
  fi
  git init -q "$destination"
  git -C "$destination" remote add origin "$url"
  git -C "$destination" fetch --progress --depth 2 origin "$commit"
  git -C "$destination" checkout -q --detach FETCH_HEAD
  test "$(git -C "$destination" rev-parse HEAD)" = "$commit" || fail "commit verification failed: $destination"
}

ensure_commit() {
  local repository="$1" commit="$2"
  if git -C "$repository" cat-file -e "$commit^{commit}" 2>/dev/null; then
    log "source commit already present: $commit"
    return
  fi
  log "fetching source commit: $commit"
  git -C "$repository" fetch --progress --depth 1 origin "$commit"
  git -C "$repository" cat-file -e "$commit^{commit}" 2>/dev/null || fail "missing source commit: $commit"
}

log '1/8 fetching and verifying pinned licensed sources'
if test -n "${BROWSERJDK_BUNDLED_SOURCE_ROOT:-}"; then
  BUNDLE="$BROWSERJDK_BUNDLED_SOURCE_ROOT"
  for required in openjdk-upstream libffi-upstream openjdk-emscripten-zero.patch \
    libffi-wasm.patch source-bundle-manifest.json; do
    test -e "$BUNDLE/$required" || fail "source bundle input missing: $required"
  done
  python3 - "$BUNDLE/source-bundle-manifest.json" \
    "$OPENJDK_UPSTREAM_COMMIT" "$OPENJDK_PORT_COMMIT" \
    "$LIBFFI_UPSTREAM_COMMIT" "$LIBFFI_PORT_COMMIT" \
    "$EMSDK_VERSION" "$EMSDK_COMMIT" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding='utf-8'))
expected = {
    'openjdkUpstreamCommit': sys.argv[2],
    'openjdkPortCommit': sys.argv[3],
    'libffiUpstreamCommit': sys.argv[4],
    'libffiPortCommit': sys.argv[5],
    'emscriptenVersion': sys.argv[6],
    'emscriptenCommit': sys.argv[7],
}
for key, value in expected.items():
    if manifest.get(key) != value:
        raise SystemExit(f'source bundle manifest mismatch for {key}')
PY
  OPENJDK_BUNDLE_PATCH_SHA="$(sha256sum "$BUNDLE/openjdk-emscripten-zero.patch" | cut -d' ' -f1)"
  LIBFFI_BUNDLE_PATCH_SHA="$(sha256sum "$BUNDLE/libffi-wasm.patch" | cut -d' ' -f1)"
  python3 - "$BUNDLE/source-bundle-manifest.json" "$OPENJDK_BUNDLE_PATCH_SHA" "$LIBFFI_BUNDLE_PATCH_SHA" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding='utf-8'))
if manifest.get('openjdkPatchSha256') != sys.argv[2]:
    raise SystemExit('source bundle OpenJDK patch hash mismatch')
if manifest.get('libffiPatchSha256') != sys.argv[3]:
    raise SystemExit('source bundle libffi patch hash mismatch')
PY
  cp -a "$BUNDLE/openjdk-upstream" "$WORK/openjdk"
  cp -a "$BUNDLE/libffi-upstream" "$WORK/libffi"
  git -C "$WORK/openjdk" apply --check "$BUNDLE/openjdk-emscripten-zero.patch"
  git -C "$WORK/openjdk" apply "$BUNDLE/openjdk-emscripten-zero.patch"
  git -C "$WORK/libffi" apply --check "$BUNDLE/libffi-wasm.patch"
  git -C "$WORK/libffi" apply "$BUNDLE/libffi-wasm.patch"
  cp "$BUNDLE/openjdk-emscripten-zero.patch" "$WORK/build/openjdk-emscripten-zero.patch"
  cp "$BUNDLE/libffi-wasm.patch" "$WORK/build/libffi-wasm.patch"
  log 'using verified source-bundle upstream trees and port patches'
else
  clone_exact "$OPENJDK_PORT_URL" "$OPENJDK_PORT_COMMIT" "$WORK/openjdk"
  clone_exact "$LIBFFI_PORT_URL" "$LIBFFI_PORT_COMMIT" "$WORK/libffi"
  ensure_commit "$WORK/openjdk" "$OPENJDK_UPSTREAM_COMMIT"
  ensure_commit "$WORK/libffi" "$LIBFFI_UPSTREAM_COMMIT"
  git -C "$WORK/openjdk" diff --binary --full-index \
    "$OPENJDK_UPSTREAM_COMMIT" "$OPENJDK_PORT_COMMIT" > "$WORK/build/openjdk-emscripten-zero.patch"
  git -C "$WORK/libffi" diff --binary --full-index \
    "$LIBFFI_UPSTREAM_COMMIT" "$LIBFFI_PORT_COMMIT" > "$WORK/build/libffi-wasm.patch"
fi
OPENJDK_PATCH_SHA="$(sha256sum "$WORK/build/openjdk-emscripten-zero.patch" | cut -d' ' -f1)"
LIBFFI_PATCH_SHA="$(sha256sum "$WORK/build/libffi-wasm.patch" | cut -d' ' -f1)"
LIBFFI_AUTOCONF_PATCH_SHA="$(sha256sum "$SRC/patches/libffi-autoconf-2.72.patch" | cut -d' ' -f1)"

log '2/8 building libffi 3.4.6 WASM static archive'
cd "$WORK/libffi"
if git apply --check "$SRC/patches/libffi-autoconf-2.72.patch" 2>/dev/null; then
  git apply "$SRC/patches/libffi-autoconf-2.72.patch"
fi
if test ! -f "$WORK/libffi-install/lib/libffi.a"; then
  if test ! -x ./configure; then autoreconf -fi; fi
  emconfigure ./configure --host=wasm32-unknown-emscripten \
    --prefix="$WORK/libffi-install" --enable-static --disable-shared --disable-docs \
    CFLAGS='-O2 -DWASM_BIGINT'
  LIBFFI_MAKE="$WORK/libffi"
  test ! -f "$WORK/libffi/wasm32-unknown-emscripten/Makefile" || LIBFFI_MAKE="$WORK/libffi/wasm32-unknown-emscripten"
  emmake make -C "$LIBFFI_MAKE" -j"$JOBS"
  emmake make -C "$LIBFFI_MAKE" install
fi
test -f "$WORK/libffi-install/lib/libffi.a" || fail 'libffi.a missing'

log '3/8 configuring and building OpenJDK Zero'
cd "$WORK/openjdk"
EMSCRIPTEN_SYSROOT="$(em-config EMSCRIPTEN_ROOT)/cache/sysroot"
LLVM_BIN="$(em-config LLVM_ROOT)"
if test ! -f "$WORK/openjdk/build/emscripten-zero/spec.gmk"; then
bash configure \
  --build=x86_64-pc-linux-gnu \
  --with-conf-name=emscripten-zero \
  --openjdk-target=wasm32-unknown-emscripten \
  --with-boot-jdk="$JAVA_HOME" \
  --with-toolchain-type=clang \
  --with-jvm-variants=zero \
  --with-jvm-features=zero,serialgc,static-build \
  --disable-jvm-feature-g1gc --disable-jvm-feature-parallelgc \
  --disable-jvm-feature-shenandoahgc --disable-jvm-feature-zgc \
  --disable-jvm-feature-epsilongc --disable-jvm-feature-jfr \
  --disable-jvm-feature-jvmci --disable-jvm-feature-dtrace \
  --disable-jvm-feature-compiler1 --disable-jvm-feature-compiler2 \
  --enable-jvm-feature-zero --enable-jvm-feature-serialgc \
  --enable-jvm-feature-static-build --enable-static-build \
  --with-libffi="$WORK/libffi-install" --with-sysroot="$EMSCRIPTEN_SYSROOT" \
  --with-extra-cflags='-pthread -sUSE_PTHREADS=1 -sSHARED_MEMORY=1 -D__EMSCRIPTEN__' \
  --with-extra-cxxflags='-pthread -sUSE_PTHREADS=1 -sSHARED_MEMORY=1 -D__EMSCRIPTEN__ -fwasm-exceptions' \
  --with-extra-ldflags='-pthread -sERROR_ON_UNDEFINED_SYMBOLS=0' \
  --disable-warnings-as-errors --with-debug-level=release \
  --with-native-debug-symbols=none --disable-precompiled-headers \
  --with-x=no --with-cups=no --with-alsa=no --with-fontconfig=no \
  --with-num-cores="$JOBS" \
  CC=emcc CXX=em++ AR=emar NM="$LLVM_BIN/llvm-nm" \
  STRIP="$LLVM_BIN/llvm-strip" OBJCOPY="$LLVM_BIN/llvm-objcopy" \
  OBJDUMP="$LLVM_BIN/llvm-objdump" BUILD_CC="$LLVM_BIN/clang" BUILD_CXX="$LLVM_BIN/clang++"
fi
make CONF=emscripten-zero buildtools-hotspot java.base-copy JOBS="$JOBS"
make CONF=emscripten-zero hotspot-only JOBS="$JOBS"
make CONF=emscripten-zero java.base-static-libs JOBS="$JOBS"

JDK_BUILD="$WORK/openjdk/build/emscripten-zero"
LIBJVM="$JDK_BUILD/jdk/lib/zero/libjvm.a"
NATIVE_BASE="$JDK_BUILD/support/native/java.base"
LIBJAVA="$NATIVE_BASE/libjava/static/libjava.a"
LIBJIMAGE="$NATIVE_BASE/libjimage/static/libjimage.a"
LIBZIP="$NATIVE_BASE/libzip/static/libzip.a"
LIBNIO="$NATIVE_BASE/libnio/static/libnio.a"
for archive in "$LIBJVM" "$LIBJAVA" "$LIBJIMAGE" "$LIBZIP" "$LIBNIO"; do
  test -f "$archive" || fail "missing OpenJDK archive: $archive"
done

log '4/8 building independent CompileServer and minimal JDK image'
rm -rf "$WORK/build/browserjdk-classes" "$WORK/build/jdk-wasm"
mkdir -p "$WORK/build/browserjdk-classes"
javac --release 21 -encoding UTF-8 -d "$WORK/build/browserjdk-classes" \
  "$SRC/src/java/org/minioj/browserjdk/CompileServer.java"
jlink --add-modules java.base,java.compiler,jdk.compiler,jdk.zipfs \
  --output "$WORK/build/jdk-wasm" --strip-debug --no-man-pages \
  --no-header-files --compress=zip-6
find "$WORK/build/jdk-wasm/bin" -type f -delete 2>/dev/null || true
find "$WORK/build/jdk-wasm/lib" \( -name '*.so' -o -name '*.dylib' \) -type f -delete
for library in libjava libzip libnio libjimage; do : > "$WORK/build/jdk-wasm/lib/$library.so"; done
find "$WORK/build/jdk-wasm" "$WORK/build/browserjdk-classes" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

log '5/8 compiling native JVM entry and generating static JNI table'
emcc -c -O3 -pthread -fwasm-exceptions \
  -I "$WORK/openjdk/src/hotspot/share/include" \
  -I "$WORK/openjdk/src/hotspot/os/posix/include" \
  -I "$WORK/openjdk/src/java.base/share/native/include" \
  -I "$WORK/openjdk/src/java.base/unix/native/include" \
  "$SRC/src/native/browserjdk_main.c" -o "$WORK/build/browserjdk_main.o"

SYMBOLS="$($LLVM_BIN/llvm-nm --defined-only "$LIBJAVA" "$LIBJIMAGE" "$LIBZIP" "$LIBNIO" "$WORK/build/browserjdk_main.o" \
  | awk '$2 == "T" { print $3 }' \
  | grep -E '^(Java_|JNI_OnLoad|JNI_OnUnload|JIMAGE_|ZIP_|JDK_|JNU_|Agent_On|GetStringPlatformChars|VerifyClassForMajorVersion)' \
  | sort -u)"
{
  echo '/* Generated static JNI lookup table. */'
  echo 'struct EmscriptenStaticSymbol { const char* name; void* addr; };'
  echo "$SYMBOLS" | sed 's/.*/extern void &(void);/'
  echo 'const struct EmscriptenStaticSymbol emscripten_static_symbols[] = {'
  echo "$SYMBOLS" | sed 's/.*/  { "&", (void*) \&& },/'
  echo '  { 0, 0 }'
  echo '};'
} > "$WORK/build/static-symbols.c"
emcc -c -O3 -pthread "$WORK/build/static-symbols.c" -o "$WORK/build/static-symbols.o"

log '6/8 linking BrowserJDK WebAssembly bundle'
em++ -O3 -mtail-call -pthread -fwasm-exceptions \
  -sUSE_PTHREADS=1 -sSHARED_MEMORY=1 -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=536870912 \
  -sPROXY_TO_PTHREAD=1 -sPTHREAD_POOL_SIZE=4 \
  -sSTACK_SIZE=4194304 -sDEFAULT_PTHREAD_STACK_SIZE=4194304 \
  -sSUPPORT_LONGJMP=wasm -sWASM_BIGINT \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createBrowserJDK \
  -sEXPORTED_FUNCTIONS='["_main","_malloc","_free","_browserjdk_control_write","_browserjdk_control_response_available","_browserjdk_control_response_read","_browserjdk_debug_state","_browserjdk_runtime_stage","_browserjdk_program_stdin_reset","_browserjdk_program_stdin_write","_browserjdk_program_stdin_close","_browserjdk_request_interrupt"]' \
  -sEXPORTED_RUNTIME_METHODS='["ccall","HEAPU8"]' \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  "$WORK/build/browserjdk_main.o" "$WORK/build/static-symbols.o" \
  -Wl,--whole-archive "$LIBJVM" "$LIBJAVA" "$LIBJIMAGE" "$LIBZIP" "$LIBNIO" \
  -Wl,--no-whole-archive "$WORK/libffi-install/lib/libffi.a" \
  -Wl,-Map="$OUT/browserjdk.link.map" \
  --preload-file "$WORK/build/jdk-wasm@/opt/jdk" \
  --preload-file "$WORK/build/browserjdk-classes@/opt/browserjdk" \
  -o "$OUT/browserjdk.mjs"
cp "$SRC/src/js/loader.mjs" "$OUT/loader.mjs"
cat "$WORK/openjdk/LICENSE" "$SRC/LICENSE" > "$OUT/LICENSE"
cat "$SRC/THIRD_PARTY_NOTICES.md" "$WORK/libffi/LICENSE" > "$OUT/THIRD_PARTY_NOTICES.md"
if test -f /emsdk/upstream/emscripten/LICENSE; then
  cat /emsdk/upstream/emscripten/LICENSE >> "$OUT/THIRD_PARTY_NOTICES.md"
fi
append_toolchain_notice() {
  local title="$1" path="$2"
  test -f "$path" || fail "missing linked toolchain notice: $path"
  printf '\n\n===== %s =====\n\n' "$title" >> "$OUT/THIRD_PARTY_NOTICES.md"
  cat "$path" >> "$OUT/THIRD_PARTY_NOTICES.md"
}
append_toolchain_notice 'LLVM compiler-rt' /emsdk/upstream/emscripten/system/lib/compiler-rt/LICENSE.TXT
append_toolchain_notice 'musl libc' /emsdk/upstream/emscripten/system/lib/libc/musl/COPYRIGHT
append_toolchain_notice 'LLVM libc++' /emsdk/upstream/emscripten/system/lib/libcxx/LICENSE.TXT
append_toolchain_notice 'LLVM libc++abi' /emsdk/upstream/emscripten/system/lib/libcxxabi/LICENSE.TXT
append_toolchain_notice 'LLVM libunwind' /emsdk/upstream/emscripten/system/lib/libunwind/LICENSE.TXT

log '7/8 writing cryptographic runtime manifest'
export OUT OPENJDK_UPSTREAM_COMMIT OPENJDK_PORT_COMMIT LIBFFI_UPSTREAM_COMMIT LIBFFI_PORT_COMMIT \
  EMSDK_VERSION EMSDK_COMMIT EMSDK_AMD64_DIGEST BUILD_JDK_VERSION BUILD_JDK_SHA256 \
  OPENJDK_PATCH_SHA LIBFFI_PATCH_SHA LIBFFI_AUTOCONF_PATCH_SHA
python3 - <<'PY'
import hashlib, json, os, pathlib, re
out = pathlib.Path(os.environ['OUT'])
link_map = (out / 'browserjdk.link.map').read_text(encoding='utf-8', errors='replace')
archives = sorted(set(re.findall(r'([^\s()/]+\.a)(?:\(|\s|$)', link_map)))
has_zlib = bool(re.search(
    r'libzip\.a\((?:adler32|crc32|deflate|inflate|inffast|inftrees|trees|zutil)\.o\)',
    link_map, re.IGNORECASE))
(out / 'LINKED_COMPONENTS.json').write_text(json.dumps({
    'evidence': 'browserjdk.link.map',
    'archives': archives,
    'embeddedComponents': ([{
        'component': 'zlib',
        'version': '1.3.1',
        'container': 'libzip.a',
        'evidence': 'linked zlib object members in browserjdk.link.map',
    }] if has_zlib else []),
    'hasZlib': has_zlib,
}, sort_keys=True, indent=2) + '\n', encoding='utf-8')
names = ['browserjdk.wasm', 'browserjdk.data', 'browserjdk.mjs',
         'browserjdk.worker.mjs', 'loader.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
         'LINKED_COMPONENTS.json']
assets = []
for name in names:
    path = out / name
    if path.exists():
        body = path.read_bytes()
        assets.append({'file': name, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
manifest = {
    'runtimeId': 'java21-browserjdk-compat-v2',
    'status': 'CHECKPOINT_2_CANDIDATE',
    'redistributable': False,
    'licenseStatus': 'CLEAR_WITH_OBLIGATIONS',
    'protocol': 'BJOJ/1',
    'javaVersion': 'OpenJDK 21.0.10+7',
    'openjdk': {'upstreamCommit': os.environ['OPENJDK_UPSTREAM_COMMIT'],
                'portCommit': os.environ['OPENJDK_PORT_COMMIT'],
                'patchSha256': os.environ['OPENJDK_PATCH_SHA']},
    'libffi': {'version': '3.4.6',
               'upstreamCommit': os.environ['LIBFFI_UPSTREAM_COMMIT'],
               'portCommit': os.environ['LIBFFI_PORT_COMMIT'],
               'patchSha256': os.environ['LIBFFI_PATCH_SHA'],
               'autoconfCompatibilityPatchSha256': os.environ['LIBFFI_AUTOCONF_PATCH_SHA']},
    'emscripten': {'version': os.environ['EMSDK_VERSION'],
                   'commit': os.environ['EMSDK_COMMIT'],
                   'imageDigest': os.environ['EMSDK_AMD64_DIGEST']},
    'buildJdk': {'version': os.environ['BUILD_JDK_VERSION'].replace('-', ' ', 1),
                 'sha256': os.environ['BUILD_JDK_SHA256']},
    'assets': assets,
}
(out / 'runtime-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + '\n', encoding='utf-8')
PY

log '8/8 build complete'
sha256sum "$OUT"/browserjdk.* "$OUT"/loader.mjs "$OUT"/runtime-manifest.json
