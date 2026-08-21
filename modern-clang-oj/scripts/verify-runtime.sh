#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="${1:?runtime output directory required}"
ROOT="$(cd "$ROOT" && pwd)"
MANIFEST="$ROOT/runtime-manifest.json"
[[ -f "$MANIFEST" ]] || { echo "missing $MANIFEST" >&2; exit 1; }
python3 - "$ROOT" <<'PY'
import hashlib, json, pathlib, sys
root=pathlib.Path(sys.argv[1])
m=json.loads((root/'runtime-manifest.json').read_text(encoding='utf-8'))
assert m['runtimeId']=='cpp-modern-engine-v1', m['runtimeId']
assert m['llvm']['commit']=='f34bba6980332ba9447397fc8bd8a0951b224747'
assert m['emscripten']['version']=='5.0.2'
for a in m.get('assets',[]):
    p=root/a['file']
    assert p.is_file(), f'missing manifest asset: {a["file"]}'
    b=p.read_bytes(); digest=hashlib.sha256(b).hexdigest()
    assert len(b)==a['bytes'], f'bytes mismatch: {a["file"]}'
    assert digest==a['sha256'], f'hash mismatch: {a["file"]}'
for name in ('clang.wasm','wasm-ld.wasm'):
    b=(root/name).read_bytes(); assert b[:4]==b'\0asm', name
    assert b[4]==1, name
    assert len(b)>1024*1024, name
print('manifest asset bytes/SHA-256: PASS')
PY
node --input-type=module - "$ROOT" <<'JS'
import fs from 'node:fs';
const root = process.argv[2];
for (const name of ['clang.wasm', 'wasm-ld.wasm']) {
  const bytes = fs.readFileSync(`${root}/${name}`);
  if (!WebAssembly.validate(bytes)) throw new Error(`WebAssembly.validate failed: ${name}`);
  console.log(`WebAssembly.validate: PASS ${name} (${bytes.length} bytes)`);
}
JS

SYSROOT="$ROOT/sysroot.tar"
[[ -f "$SYSROOT" ]] || { echo 'missing sysroot.tar' >&2; exit 1; }
inventory="$(tar -tf "$SYSROOT")"
for required in \
  './include/c++/v1/' \
  './lib/wasm32-wasi/libc++.a' \
  './lib/wasm32-wasi/libc++abi.a' \
  './lib/clang/19.1.7/lib/wasm32-unknown-wasi/libclang_rt.builtins-wasm32.a' \
  './lib/clang/19.1.7/include/' \
  './lib/wasm32-wasi/crt1.o'; do
  if [[ "$required" == './lib/wasm32-wasi/crt1.o' ]]; then
    grep -Fqx './lib/wasm32-wasi/crt1-command.o' <<<"$inventory" && continue
  fi
  grep -Fqx "$required" <<<"$inventory" || {
    echo "sysroot inventory missing: $required" >&2
    exit 1
  }
done
echo 'sysroot required inventory: PASS'
echo 'MODERN_CLANG_RUNTIME_VERIFY_PASS'
