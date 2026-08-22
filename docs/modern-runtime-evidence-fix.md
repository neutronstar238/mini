# Modern Runtime Evidence Fix (cpp-modern-engine-v1)

## Scope

This evidence fix audits the already-published `cpp-modern-engine-v1` runtime.
It does not rebuild LLVM/Clang/LLD, edit a runtime binary, or rewrite any v1
manifest. The verifier reads the final publication and the two clean
reproducibility outputs, then writes:

```text
compat-tests/modern-cpp/results/modern-runtime-evidence.json
```

Run it from the repository root with:

```powershell
node scripts/verify-modern-runtime-evidence.mjs
```

The command exits non-zero and still writes an evidence record if a declared
pin, file, byte count, digest, or reproducibility comparison drifts. The
directories can be overridden with `--published`, `--repro-a`, `--repro-b`,
`--llvm-source`, `--pins`, and `--output`.

## Hash semantics audit

The final v1 manifest contains no `runtimeAssetHash`, `manifestFileSha256`,
`assetHash`, or `assetsHash` field. Therefore the v1 evidence is not a
self-referential manifest hash. The verifier reads the final manifest file
from disk and applies SHA-256 directly to its raw bytes:

```text
rawManifest = readFile(finalPublishedV1/runtime-manifest.json)
manifestFileSha256 = SHA256(rawManifest)
runtimeAssetHash = manifestFileSha256       # external v1 evidence value
```

There is no JSON canonicalization, field removal, or hash-field injection in
this path. `runtimeAssetHash` names the legacy runtime identity evidence,
while `manifestFileSha256` names the raw manifest-file digest; they are equal
for this v1 contract because both are computed from the same final raw file,
not because the manifest contains either value.

Observed final published values:

| Field | Value |
|---|---|
| Manifest bytes | `6357` |
| `runtimeAssetHash` | `25433ade343cb3e2e3a3255c5a26ffc600b659d26d296749c33ac34d1afaff3c` |
| `manifestFileSha256` | `25433ade343cb3e2e3a3255c5a26ffc600b659d26d296749c33ac34d1afaff3c` |

## Asset-set definitions

The final publication is `server/public/js/runtime/cpp-modern-engine-v1`.
The verifier checks every `assetInventory` item against the final file on
disk, including both byte length and SHA-256, and checks every `assets` live
entry against the same inventory.

| Set | Count | Definition |
|---|---:|---|
| Published Runtime Manifest Set | 18 | `runtime-manifest.json.assetInventory` |
| Live Runtime Set | 6 | `runtime-manifest.json.assets` (compiler/linker/glue/sysroot/loader) |
| Build Reproducibility Set | 20 | Every physical file in each repro/public directory |
| Non-inventory metadata files | 2 | `asset-index.json`, `runtime-manifest.json` |

The machine-readable JSON contains the complete 18-item inventory with
`file`, `bytes`, and `sha256`, the complete 6-item live set, and all 20
physical files. `repro-a`, `repro-b`, and the public v1 directory are currently
byte- and digest-identical, including their manifests and asset indexes.

## Source and toolchain pin evidence

The verifier executes Git object queries against
`modern-clang-oj/src/llvm-project` and validates the manifest and
`PINNED_SOURCES.env` values:

| Evidence | Value |
|---|---|
| LLVM tag | `llvmorg-19.1.7` |
| LLVM tag object SHA | `f34bba6980332ba9447397fc8bd8a0951b224747` (`tag`) |
| LLVM peeled source commit | `cd708029e0b2869e80abe31ddb175f7c35361f90` (`commit`) |
| Emscripten | `5.0.2`, commit `c817c0ca4ba889ee24a185fd954cff7de1bd8afa` |
| Emscripten image | `emscripten/emsdk:5.0.2` |
| Emscripten image digest | `sha256:559781dfc5570c6670d74930a04dfe131cff611b4088761662493d537b87976d` |
| wasi-libc | requested/resolved commit `574b88da481569b65a237cb80daf9a2d5aeaf82d` |

The LLVM requested commit is intentionally the annotated tag object SHA. The
reproducible source checkout is the peeled commit SHA; these are the expected
tag-object/commit relationship, not an unexplained checkout drift.

## Verification result

The verifier produced `evidenceConsistency = PASS` with:

- raw manifest hash: PASS;
- 18 inventory entries and 6 live entries: PASS;
- all declared bytes and SHA-256 values: PASS;
- 20-file `repro-a`/`repro-b`/public comparison: PASS;
- LLVM tag-object and peeled-commit checks: PASS;
- Emscripten and wasi-libc pin checks: PASS.

No Engine ID upgrade is required: this is documentation/evidence tooling only,
so the runtime remains `cpp-modern-engine-v1`.
