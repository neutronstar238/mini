# Java 21 Redistribution Engineering Gate

结论：`ENGINEERING_REDISTRIBUTION_READY=true`，但 `LEGAL_REVIEW_REQUIRED=true` 且 `REDISTRIBUTABLE=false`。本文是工程核查，不是法律批准。

| # | Gate | Evidence | Result |
|---:|---|---|---:|
| 1 | Runtime 全部 self-built | OpenJDK 21u + port + libffi + Emscripten build | PASS |
| 2 | 无 JavaBox dependency | runtime/build/network inventory 均无 JavaBox binary/glue/CDN | PASS |
| 3 | upstream exact commit 固定 | OpenJDK、port、libffi、Emscripten commit/digest 固定 | PASS |
| 4 | license matrix 完整 | 真实 linker map、data image、build inputs 驱动 | PASS |
| 5 | LICENSE 完整 | runtime 与 source distribution 均包含 | PASS |
| 6 | notices 完整 | 包含实际静态链接项及 zlib 1.3.1 notice | PASS |
| 7 | linker inventory | `LINKED_COMPONENTS.json` + `browserjdk.link.map` | PASS |
| 8 | 修改 source 可提供 | exact upstream snapshots + port patches | PASS |
| 9 | build scripts 可提供 | `BUILDING.md`、Docker/build scripts 在 bundle 内 | PASS |
| 10 | source bundle 已生成 | final tar.gz + manifest | PASS |
| 11 | binary/source 一一对应 | manifest commits、patch hashes、toolchain digest | PASS |
| 12 | 两次 clean build 可复现 | A/B 的 7 个 manifest assets byte-identical | PASS |

## Reproducible binary build

Clean build A：`browserjdk-oj/.build/checkpoint2-clean-a-20260821`；B：`browserjdk-oj/.build/checkpoint2-clean-b-20260821`。两者 7 个 manifest assets 逐字节一致。关键 hash：`browserjdk.wasm=7f2acfac…dfc4c`、`browserjdk.data=cbe3b484…ccc82`、`browserjdk.mjs=8c445a96…8ad0c`、`loader.mjs=cd8b4bef…c2520`。

## Source reproducibility

Final bundle：`browserjdk-oj/dist/checkpoint2-source-final-20260821/browserjdk-oj-source.tar.gz`，SHA-256 `c14bd7af2b1b30c5da3a5b887de5f5eb85a976c2b2765abe78d9bacd852c3ac3`。仅使用该 archive、配套 `source-bundle-manifest.json` 与固定 Docker build image，在 `checkpoint2-source-runtime-fast3-20260821` 离线展开并构建；所得 7 assets 与 clean build A 逐字节一致。

完整 component/commit/license/modified/static/bundled/redistributed/source/notice/obligation/status 字段见 `browserjdk-oj/THIRD_PARTY_LICENSE_MATRIX.md`。Classpath Exception 只按具体文件 header 记录，不对整个 fork 作全局假设。独立 JS adapter 为 MIT；进入 WASM/data 的 native glue、OpenJDK modifications 和 port patches 按其真实条款记录。

机器证据：`compat-tests/java21/results/java21-redistribution-engineering-gate.json`。
