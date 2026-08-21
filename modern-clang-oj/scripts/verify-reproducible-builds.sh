#!/usr/bin/env bash
set -Eeuo pipefail
MARK_PASS=0
if [[ "${1:-}" == "--mark-pass" ]]; then
    MARK_PASS=1
    shift
fi
A="${1:?first output directory required}"
B="${2:?second output directory required}"
REPRO_MARK_PASS="$MARK_PASS" python3 - "$A" "$B" <<'PY'
import hashlib, json, os, pathlib, sys
def load(root):
    root=pathlib.Path(root); m=json.loads((root/'runtime-manifest.json').read_text())
    actual={}
    for p in sorted(root.rglob('*')):
        if p.is_file():
            actual[str(p.relative_to(root)).replace('\\','/')] = (p.stat().st_size, hashlib.sha256(p.read_bytes()).hexdigest())
    return m,actual
def compare(a, b):
    ma,aa=load(a); mb,ab=load(b)
    if ma != mb:
        raise SystemExit('REPRODUCIBILITY FAIL: runtime manifests differ')
    if aa != ab:
        for name in sorted(set(aa)|set(ab)):
            if aa.get(name) != ab.get(name): print(f'asset differs: {name}: {aa.get(name)} != {ab.get(name)}')
        raise SystemExit('REPRODUCIBILITY FAIL: published assets differ')
    return len(aa)
count = compare(sys.argv[1], sys.argv[2])
if os.environ.get('REPRO_MARK_PASS') == '1':
    for root_name in sys.argv[1:3]:
        path = pathlib.Path(root_name) / 'runtime-manifest.json'
        manifest = json.loads(path.read_text())
        manifest['reproducibleBuild'] = 'PASS'
        path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    count = compare(sys.argv[1], sys.argv[2])
print(f'Reproducible Build: PASS ({count} assets byte-identical)')
PY
