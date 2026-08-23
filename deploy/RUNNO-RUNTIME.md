# Runno 运行时二进制部署说明

Web IDE 的浏览器内 C/C++ 运行时依赖 3 个 WASI 语言资产，合计约 **50MB**。
出于仓库体积考虑，这些二进制已通过 `.gitignore` 排除，**不入 git 仓库**。

## 需要的文件

放在 `server/public/js/runno/langs/`（Web IDE 通过 `runno-loader` / `ide-runner` 在此目录按名加载）：

| 文件 | 大小 | 用途 |
|---|---|---|
| `clang.wasm` | ~30MB | C/C++ 编译器前端（clang 8.0.1） |
| `wasm-ld.wasm` | ~19MB | 链接器（wasm-ld / LLD） |
| `clang-fs.tar.gz` | ~1.7MB | C/C++ sysroot（含 libc/libc++ 头与 `bits/stdc++.h` shim） |

## 为什么不入库

- 合计约 50MB，远大于本项目其余代码，拖慢 clone/部署。
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
升级 Runno 或从官方渠道获取时，将下载的 clang、wasm-ld 及 sysroot 按上面文件名放置到
`server/public/js/runno/langs/`。脚本会逐文件校验固定 SHA-256；不同版本不能直接混用。

## 版本绑定（重要）

Runtime 版本绑定 `cpp11-gcc11-compat-v5`，即：
**编译器 clang 8.0.1 + 语言 c++11 + sysroot + PCH + shim 版本** 共同进入 artifact/runtime hash。

⚠️ 若更换 clang 版本（升级 Runno 或换编译器），必须：
1. 重新生成/放置新版本二进制；
2. 同步更新 `ide-runner.js` 顶部的 `RUNNO_VERSION`（当前 `0.10.0-ojc4`）使旧缓存失效；
3. **重新生成 `bits/stdc++.h` 的 PCH**（PCH 与编译器/flags 严格绑定），避免静默复用旧版本产物。

## 部署集成

`deploy/deploy-server.ps1` 打包 `server/public` 时会**自动包含**本地已有的 `langs/` 二进制
（本地有则带上，服务器即可运行 Web IDE 编译）。若目标服务器是从 git 全新 clone 的干净环境，
先运行 `fetch-runno-runtime.ps1` 补齐二进制再部署。

## 一致性

- 本地 `server/public/js/runno/langs/` 为唯一真源；git 不追踪其内容。
- 修改 shim（`clang-fs.tar.gz` 内 `bits/stdc++.h`）后，二进制仍在本地、仍随本地部署打包；
  但 git clone 新环境需通过 `fetch-runno-runtime.ps1` 从已修改的本地副本同步。

## cross-origin isolation 部署要求（COOP/COEP，必须满足）

C/C++ WASI（Runno）与 Python（Pyodide）浏览器运行时都依赖 **SharedArrayBuffer** 做 stdin 推送 / 超时中断，
而 SharedArrayBuffer 仅在 **cross-origin isolated** 上下文可用。因此选手端（contest）页面必须同时下发：

| 响应头 | 值 | 作用 |
|---|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin` | 断开跨源窗口句柄，满足 isolation |
| `Cross-Origin-Embedder-Policy` | `require-corp` | 禁止加载无 CORP 的跨源子资源 |

- **已内建**：`server/src/app.js` 对 contest 入口（host 匹配 `config.domainContest` 或路径前缀 `/contest`、`/js/contest`）自动下发这两个头。
- **反向代理**：若生产用 Nginx 反代，COOP/COEP 由后端 Express 下发并经 `proxy_pass` 原样透传。**不得**在 Nginx 层覆盖为 non-isolated（见 `deploy/nginx/nginx.conf` 注释）。
- **验证**：浏览器 DevTools → Network → 响应头确认两个头存在；`window.crossOriginIsolated === true`。
- 若因 CDN/反代剥离导致 isolation 失败，Python 无限循环将走 **FALLBACK** 策略（Local Timeout → terminate Worker → 下次 Run 重建），仍不卡死页面，但无法用 KeyboardInterrupt 优雅中断。C/C++ 无限循环依赖 SAB 中断，若 isolation 失败会导致本地执行卡至超时。

## Python Runtime 资产（自托管 Pyodide）

Python 解释型运行时已改用**自托管 Pyodide 0.26.4 / CPython 3.12.1**（`server/public/js/pyodide/`，~13.2MB，6 个资产），
不再依赖 Runno 的 `python-3.11.3.wasm`。资产不入 Git；在仓库根目录运行：

```powershell
.\deploy\fetch-pyodide-runtime.ps1
.\deploy\fetch-pyodide-runtime.ps1 -VerifyOnly
```

脚本锁定 Pyodide 0.26.4，并逐文件校验 SHA-256，下载中断不会覆盖已有文件。浏览器通过稳定版本路径
`/runtime/pyodide/0.26.4/` 加载，`server/src/app.js` 只对该版本化路径配置 `immutable` 长缓存；
兼容旧路径 `/js/pyodide/` 强制重新验证，防止同 URL 内容变更后继续命中旧缓存。
注意：Pyodide 资产同样依赖上述 COOP/COEP cross-origin isolation（SAB 中断）。
