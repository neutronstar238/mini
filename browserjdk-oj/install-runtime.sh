#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${1:-$ROOT/runtime}"
TARGET="${2:-$ROOT/../server/public/js/runtime/java21-browserjdk-compat-v2}"
test -f "$SOURCE/runtime-manifest.json" || { echo 'BUILD_REQUIRED / NOT_READY: manifest missing' >&2; exit 2; }
mkdir -p "$TARGET"
python3 - "$SOURCE" "$TARGET" <<'PY'
import hashlib, json, pathlib, shutil, sys
source, target = map(pathlib.Path, sys.argv[1:])
manifest = json.loads((source / 'runtime-manifest.json').read_text(encoding='utf-8'))
if manifest.get('runtimeId') != 'java21-browserjdk-compat-v2':
    raise SystemExit('unexpected runtimeId')
for asset in manifest.get('assets', []):
    path = source / asset['file']
    body = path.read_bytes()
    if len(body) != asset['bytes'] or hashlib.sha256(body).hexdigest() != asset['sha256']:
        raise SystemExit('source asset hash mismatch: ' + asset['file'])
    shutil.copyfile(path, target / asset['file'])
shutil.copyfile(source / 'runtime-manifest.json', target / 'runtime-manifest.json')
for asset in manifest['assets']:
    body = (target / asset['file']).read_bytes()
    if hashlib.sha256(body).hexdigest() != asset['sha256']:
        raise SystemExit('installed asset hash mismatch: ' + asset['file'])
print('installed and verified', len(manifest['assets']), 'assets at', target)
PY
