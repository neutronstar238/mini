# Runno 运行时二进制部署说明

Web IDE 的浏览器内 C/C++/Python 运行时依赖 5 个 WASI 语言资产，合计约 **74MB**。
出于仓库体积考虑，这些二进制已通过 `.gitignore` 排除，**不入 git 仓库**。

## 需要的文件

放在 `server/public/js/runno/langs/`（Web IDE 通过 `runno-loader` / `ide-runner` 在此目录按名加载）：

| 文件 | 大小 | 用途 |
|---|---|---|
| `clang.wasm` | ~30MB | C/C++ 编译器前端（clang 8.0.1） |
| `wasm-ld.wasm` | ~19MB | 链接器（wasm-ld / LLD） |
| `clang-fs.tar.gz` | ~1.7MB | C/C++ sysroot（含 libc/libc++ 头与 `bits/stdc++.h` shim） |
| `python-3.11.3.wasm` | ~20MB | Python 3.11 解释器 |
| `python-3.11.3.tar.gz` | ~3.9MB | Python 标准库 |

## 为什么不入库

- 合计约 74MB，远大于本项目其余代码，拖慢 clone/部署。
- 属第三方（Runno `@runno/wasi`）发行资产，非本项目源码，不宜作为仓库核心内容。
- JS 运行时代码（`runno-runtime.js` / `runno-wasi.js`，~1.7MB）**已入库**，仅二进制排除。

## 如何获取 / 放置

### 方式 A：从本地已运行副本复制（推荐，最可靠）

从任意已部署/已拉取过二进制的 `server/public/js/runno/langs/` 目录复制即可：

```powershell
# 在仓库根目录
.\deploy\fetch-runno-runtime.ps1 -Source "D:\已有副本\langs"
```

### 方式 B：本地默认源

若当前工作区的 `server/public/js/runno/langs/` 已有完整二进制（本地开发常见），直接：

```powershell
.\deploy\fetch-runno-runtime.ps1          # 默认从本地 server/public/js/runno/langs 复制
.\deploy\fetch-runno-runtime.ps1 -VerifyOnly  # 仅校验目标是否齐全
```

### 方式 C：从 Runno 发行渠道获取

这些二进制来自 Runno 项目（`@runno/wasi`，[runno.dev](https://runno.dev)）的 WASI 语言运行时。
升级 Runno 或从官方渠道获取时，将下载的 clang/python wasm 及 sysroot 按上面文件名放置到
`server/public/js/runno/langs/` 即可。**文件名校验**：`fetch-runno-runtime.ps1 -VerifyOnly`。

## 版本绑定（重要）

Runtime 版本绑定 `cpp11-gcc11-compat-v1`，即：
**编译器 clang 8.0.1 + 语言 c++11 + sysroot + PCH + shim 版本** 共同进入 artifact/runtime hash。

⚠️ 若更换 clang 版本（升级 Runno 或换编译器），必须：
1. 重新生成/放置新版本二进制；
2. 同步更新 `ide-runner.js` 顶部的 `RUNNO_VERSION`（`0.10.0-ojc2`）使其失效；
3. **重新生成 `bits/stdc++.h` 的 PCH**（PCH 与编译器/flags 严格绑定），避免静默复用旧版本产物。

## 部署集成

`deploy/deploy-server.ps1` 打包 `server/public` 时会**自动包含**本地已有的 `langs/` 二进制
（本地有则带上，服务器即可运行 Web IDE 编译）。若目标服务器是从 git 全新 clone 的干净环境，
先运行 `fetch-runno-runtime.ps1` 补齐二进制再部署。

## 一致性

- 本地 `server/public/js/runno/langs/` 为唯一真源；git 不追踪其内容。
- 修改 shim（`clang-fs.tar.gz` 内 `bits/stdc++.h`）后，二进制仍在本地、仍随本地部署打包；
  但 git clone 新环境需通过 `fetch-runno-runtime.ps1` 从已修改的本地副本同步。
