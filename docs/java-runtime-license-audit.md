# Java Runtime License Audit

> **Phase 7 Checkpoint 1 update (2026-08-21)**：工程审计结论为 `CLEAR_WITH_OBLIGATIONS`。正式资产已具备分层许可证、真实链接组件 notices、patch 署名和完整 source bundle；A14 最终 Gate 与项目责任人/法律复核尚未完成，因此 `REDISTRIBUTABLE=false`。详情见 `docs/JAVA_PHASE7_CHECKPOINT_1.md`。

> **Phase**: 6 (Runtime Enhancement Phase 后续)
> **Date**: 2026-08-21
> **Decision-maker**: Mini-OJ maintainers + 下游部署者
> **Scope**: Java 21 Browser Local runtime 的合法、明确、可审计再分发能力

---

## 1. 审计目的与约束

Mini-OJ 是程序设计竞赛 OJ 平台，未来可能部署为公开比赛、复制到其他服务器、对外发布。Java 21 Browser Local runtime 必须满足：

1. **合法再分发**：每个二进制 / 源文件能溯源到上游许可证，且上游许可证允许 Mini-OJ 这种"作为 OJ 平台运行 + 复制 + 二次分发"的使用方式。
2. **明确来源**：禁止依赖"个人 Cloudflare Worker 上的 76MB prebuilt"或"无 LICENSE 仓库的 binary blob"等黑箱资产。
3. **可重复构建**：`git clone + 固定 commit + 固定 emsdk + build command` 在 Docker reproducible container 中产出 deterministic binary hash。
4. **三态门控**：技术验证、来源合规、自托管能力分别独立判定，缺一不可。

---

## 2. 候选方案许可证审计

| 候选方案 | 上游许可证 | 可再分发 | 备注 |
|---|---|---|---|
| **JavaBox** (`bmarti44/javabox`) | **未知**（仓库根 LICENSE 404） | ❌ NO | jvm-main.c / CompileServer.java / build scripts / web/ 自身许可证不明；prebuilt 来自作者个人 Cloudflare Worker，无 hash 校验；**禁止 vendor** |
| CheerpJ | Community 仅非商业；商业付费 | ⚠️ LIMITED | Java 8-17 only，Java 21 不完整支持 |
| TeaVM / JWebAssembly | Apache-2.0 | ✅ YES | 但这是 source-to-WASM AOT，**不**是浏览器内 JVM；不可编译用户 Java 源码 |
| GraalVM Web Image | GPLv2+CE（GraalVM CE） | ⚠️ LIMITED | AOT-only，无 in-browser source 编译路径 |
| WebVM (Leaning Technologies) | Apache-2.0（部分） | ⚠️ LIMITED | 总 runtime > 200MB，资源代价不可接受 |

**结论**：四个候选方案均不满足 Mini-OJ "Java 21 in-browser source 编译"目标 + 可再分发 → 走自建路径。

---

## 3. 自建路径许可证决策

`browserjdk-oj/` 工程（见 `../browserjdk-oj/`）上游仅采用以下组件，每个组件均有明确许可证：

| 组件 | 上游许可证 | 是否允许静态链接 + 再分发 Mini-OJ binary |
|---|---|---|
| OpenJDK 21u | GPLv2 + Classpath Exception | ✅ YES（Classpath Exception 是 OpenJDK 专门为这种场景设计的） |
| Emscripten SDK | MIT / UIUC/NCSA（双许可） | ✅ YES（permissive） |
| Emscripten bundled: musl libc, compiler-rt | MIT / UIUC/NCSA | ✅ YES |
| LLVM/Clang (used by emsdk at build time) | Apache-2.0 + LLVM Exceptions | ✅ YES（构建时使用，不静态链接进 wasm） |
| libffi | LGPL-2.1-or-later (also MIT-style for some parts) | ✅ YES（提供完整 source for relinking；满足 LGPL §6） |
| browserjdk-oj 自有代码 | GPLv2+CE OR MIT（双许可，本项目自选） | ✅ YES（自有代码自由选择） |

详见 `browserjdk-oj/THIRD_PARTY_LICENSE_MATRIX.md`。

---

## 4. JavaBox 处理决定

| 维度 | 决定 |
|---|---|
| JavaBox prebuilt 是否进入正式 distribution？ | **否**——`REDISTRIBUTION_NOT_ASSUMED` |
| JavaBox prebuilt 是否可用于 PoC / 技术参考？ | **是**——`TECHNICAL_REFERENCE_ONLY` |
| JavaBox 源码是否 vendor 到 Mini-OJ？ | **否**——License 缺失，零复用 |
| JavaBox 思路是否借鉴？ | **是**——技术架构层面（Persistent JVM + JSR-199 + MemoryClassLoader）作为工程参考；具体实现全部独立完成 |
| JavaBox 已知缺陷（stdin 半双工）是否被规避？ | **是**——见 §5（自建路径的隔离设计） |

---

## 5. 自建路径的隔离设计（区别于 JavaBox）

| 风险点 | JavaBox 实际行为 | browserjdk-oj 隔离设计 |
|---|---|---|
| CompileServer stdin 与 program System.in 共享 | 共用 `BufferedReader in = new BufferedReader(System.in)`；Scanner.nextInt 阻塞导致协议 reader 死锁（实测 25s timeout） | **物理隔离**：CompileServer 协议走专用 SharedArrayBuffer `compileSab`；program System.in 走独立 ring buffer `stdinSab`；invoke 前反射替换 `System.in`，invoke 后还原 |
| LICENSE 缺失 | 仓库根 LICENSE 404 | GPLv2+CE + 完整上游许可证链 |
| Prebuilt CDN 黑箱 | 个人 Cloudflare Worker，无 hash | 不提供 CDN；self-host 到 `/runtime/java21-browserjdk-compat-v1/`，二进制 SHA-256 写入 manifest |
| 不可重复构建 | 仅作者本地 build-direct.sh | Docker reproducible container + 锁定 commit + 确定性 hash 校验 |
| fork patch license 状态不明 | JavaBox 维护者未明列 patch license | 每个 modified file 头部加 `// Modified by browserjdk-oj, Apache-2.0 (or GPLv2+CE matching original)`；patchset SHA-256 写入 manifest |

---

## 6. 三态门控

| 状态 | 含义 | Mini-OJ 运行时可见性 | 触发条件 |
|---|---|---|---|
| `SCAFFOLD` | 工程脚手架已建；无 wasm 产物 | 不可见 | 当前状态（2026-08-21） |
| `TECHNICAL_PO_ONLY` | 有 PoC 验证（可能基于第三方 prebuilt） | 不可见 | Milestone-1 已达成 |
| `REDIST_BLOCKED` | 自建 wasm 已产出，但 License Audit 未通过 | 不可见 | 缺上游 commit / 缺 Notice / 缺 patch source / 缺 build reproducibility 之一 |
| `REDIST_OK` | 自建 wasm + License Audit 全部通过 | ✅ 可见 | 全部 audit checkbox checked |

### 当前 status = SCAFFOLD / TECHNICALLY_PO_ONLY

- TECHNICALLY_VALIDATED = **true**（JavaBox prebuilt PoC 5/6 PASS，详见 `java-milestone-1.md`）
- REDISTRIBUTABLE = **false** → 整体 **DISTRIBUTION_BLOCKED**

---

## 7. 进入 REDIST_OK 必须完成的事项

按 `browserjdk-oj/THIRD_PARTY_LICENSE_MATRIX.md` §E Audit Checklist 全部打勾：

- [ ] A1/A2/A3 — 上游 OpenJDK 21u / libffi commit/tag 锁定，patch diff 提交，Notice 复制完整
- [ ] B1/B2 — Emscripten SDK commit 锁定，NOTICE 复制完整
- [ ] C1-C5 — 自有代码无外部依赖，无需进一步审计
- [ ] F1 — `git grep` 验证无 JavaBox / CheerpJ / TeaVM / WebVM 代码 vendor
- [ ] F2 — `runtime-manifest.json` 所有 hash 字段填实
- [ ] F3 — `build-runtime.sh` 在 Docker reproducible container 中 deterministic output（两次 build SHA-256 一致）
- [ ] F4 — OpenJDK WASM patch source 公开 git 可获取
- [ ] F5 — 12 ACM Corpus + Browser vs Server Matrix 在 self-built runtime 上 PASS

---

## 8. Redistribution Gate 决策流程

```
                ┌────────────────────┐
                │ SCAFFOLD           │
                │ (engineering)      │
                └────────┬───────────┘
                         │ build-runtime.sh 成功
                         ▼
                ┌────────────────────┐
                │ TECHNICAL_PO_ONLY  │ ← Milestone-1 PoC (JavaBox prebuilt)
                │                    │
                └────────┬───────────┘
                         │ self-built wasm + License Audit checkbox all checked
                         ▼
                ┌────────────────────┐
                │ REDIST_OK          │ → Mini-OJ 正式启用 Java Browser Local
                │                    │
                └────────────────────┘
        任意 checklist 未完成 → REDIST_BLOCKED
```

---

## 9. 审计结论

| 维度 | 结论 |
|---|---|
| 技术可行性 | ✅ TECHNICALLY_VALIDATED（Milestone-1 PoC 5/6 PASS） |
| 来源合规 | ❌ 暂时 DISTRIBUTION_BLOCKED（JavaBox prebuilt 仅作 PoC；self-build 待执行） |
| 可重复构建 | 🔧 工程入口已建立（`browserjdk-oj/build-runtime.sh`），实际 deterministic build 待 Linux 构建机执行 |
| Source availability | 🔧 上游 commit/tag 锁定待 build 时填写 |
| Notice / 第三方归属 | ✅ 框架已建立（`THIRD_PARTY_NOTICES.md` + `THIRD_PARTY_LICENSE_MATRIX.md`） |
| 自托管能力 | ✅ 路径已规划（`/runtime/java21-browserjdk-compat-v1/`） |

**最终 Distribution Status**: `DISTRIBUTION_BLOCKED`（技术开发可继续；正式比赛 OJ 部署不允许 vendor）。

**下次 phase 目标**: 完成 `browserjdk-oj/build-runtime.sh` 第一次 successful build + License Audit 全部 checkbox → status 升级 `REDIST_OK` → Mini-OJ 正式启用 Java Browser Local。
