#!/usr/bin/env bash
set -euo pipefail

A="${1:?first clean output directory is required}"
B="${2:?second clean output directory is required}"
python3 - "$A" "$B" <<'PY'
import hashlib
import json
import pathlib
import sys

def load(root):
    root = pathlib.Path(root)
    manifest_path = root / 'runtime-manifest.json'
    if not manifest_path.is_file():
        raise SystemExit(f'{root}: runtime-manifest.json is missing')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    actual = {}
    for asset in manifest.get('assets', []):
        name = asset['file']
        path = root / name
        if not path.is_file():
            raise SystemExit(f'{root}: missing manifest asset {name}')
        body = path.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        if asset.get('bytes') != len(body) or asset.get('sha256') != digest:
            raise SystemExit(f'{root}: manifest hash mismatch for {name}')
        actual[name] = (len(body), digest)
    return manifest, actual

manifest_a, assets_a = load(sys.argv[1])
manifest_b, assets_b = load(sys.argv[2])
if manifest_a != manifest_b:
    raise SystemExit('runtime manifests differ')
if assets_a != assets_b:
    names = sorted(set(assets_a) | set(assets_b))
    for name in names:
        if assets_a.get(name) != assets_b.get(name):
            print(f'asset differs: {name}: {assets_a.get(name)} != {assets_b.get(name)}', file=sys.stderr)
    raise SystemExit(1)
for root in (pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])):
    link_map = root / 'browserjdk.link.map'
    inventory = root / 'LINKED_COMPONENTS.json'
    if not link_map.is_file() or not inventory.is_file():
        raise SystemExit(f'{root}: linker evidence is incomplete')
print(f'REPRODUCIBLE: {len(assets_a)} manifest assets match byte-for-byte')
PY
