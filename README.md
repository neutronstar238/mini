# Mini-OJ —— Chrome 本地预检与可信边缘评测分布式方案

> 依据《在线评测系统（OJ）——Chrome 浏览器本地预检与可信边缘评测分布式方案项目立项申请书》立项。
> 核心创新：**评测拆分「浏览器本地预检 + 可信边缘评测」两条解耦路径，服务器正常路径不运行参赛代码**。
> UI 风格复用开源仓库 [CCPCOJ](https://github.com/CSGrandeur/CCPCOJ)（Bootstrap 3 扁平化）。

研究计划详见 [plan.md](./plan.md)，接口文档详见 [docs/api.md](./docs/api.md)。

## 三域架构

```
不可信域：选手 Chrome 内 WASM 本地预检（公开样例，不接触隐藏数据）
中心控制域：OJ Core :3001（唯一 DB Owner + 唯一 Scheduler + 唯一 Worker Registry）
           Admin   :3002（独立管理 Web，无 DB 直连，经 :3001 internal API）
可信执行域：Trusted Windows Judge Worker APP（Electron + WSL2 + Isolate 沙箱）
```

**核心原则**：单 Scheduler、单 DB Owner、数据一致性、正式判题公平性。
详见 [docs/architecture.md](./docs/architecture.md)。

## 双 Web 入口（两个独立域名）

| 入口 | 域名示例 | 服务端口 | 定位 |
|---|---|---|---|
| 选手端 | `contest.example.com` | :3001 | 题面/编辑器+本地预检/提交/状态/榜单 |
| 管理端 | `admin.example.com` | :3002 | 总览/节点/证书/队列/审计/重判/日志 |

两个入口为**两个独立 Node 服务**（`APP_ENTRY=contest|admin` 启动），部署时经 Nginx 分别反代。
:3002 所有管理操作经 `:3001/internal/admin/*`（HMAC 内部鉴权）完成，**不直连数据库**。

## 快速启动

### 1. 服务端（中心控制域）— 两个独立服务

```bash
cd server
npm install --registry=https://registry.npmmirror.com

# OJ Core（选手端 :3001，唯一 DB Owner + Scheduler）
# Windows PowerShell:
$env:APP_ENTRY="contest"; $env:PORT="3001"; $env:DB_FILE="e:\mini\server\data\mini-oj.db"; $env:INTERNAL_API_SECRET="dev-secret"; node src/app.js
# Linux:
# APP_ENTRY=contest PORT=3001 DB_FILE=... INTERNAL_API_SECRET=dev-secret node src/app.js

# Admin（管理端 :3002，代理到 :3001）
$env:APP_ENTRY="admin"; $env:PORT="3002"; $env:DB_FILE="e:\mini\server\data\mini-oj.db"; $env:INTERNAL_API_SECRET="dev-secret"; $env:CORE_BASE_URL="http://127.0.0.1:3001"; node src/app.js
# Linux:
# APP_ENTRY=admin PORT=3002 DB_FILE=... INTERNAL_API_SECRET=dev-secret CORE_BASE_URL=http://127.0.0.1:3001 node src/app.js
```

访问：选手端 `http://localhost:3001`，管理端 `http://localhost:3002`。
种子数据：管理员 `admin/admin123`，选手 `user1/user123`，Worker 演示注册码 `OJ-DEMO-WORKER-2024`。

### 2. 可信 Worker（可信执行域）

```bash
cd worker
# 方式一：Electron APP（需 WSL2 + Ubuntu-22.04 + g++/python3）
npm install && npm start
# 方式二：headless（联调演示，本机无 WSL 时回退本地编译器）
node judge/headless.js --register OJ-DEMO-WORKER-2024 --server http://localhost:3001
node judge/headless.js --server http://localhost:3001
```

> Worker 连接的是 **OJ Core :3001**（唯一控制面），不连接 :3002。

> 本机演示如 WSL 发行版非 22.04，可 `$env:MINIOJ_WSL_DISTRO="Ubuntu-24.04"`。

### 3. 演示流程

1. 管理端登录 `admin/admin123` → 节点管理：审批并认证 Worker 为「可信」；
2. 选手端登录 `user1/user123` → 打开题目 → 编辑器内「本地预检（公开样例）」→ 提交；
3. 提交经完整状态机（SUBMITTED→PENDING→LEASED→RUNNING→AC/WA/TLE）由可信 Worker 评测；
4. 榜单与审计实时更新。

## 核心特性（对照申请书）

- [x] 浏览器本地预检：公开样例在 WASM/Pyodide 内试跑（不装软件、不接触隐藏测试点）
- [x] 三域解耦：服务器正常路径不运行参赛代码，正式评测仅经可信 Worker
- [x] 可信 Worker：Electron + WSL2 + Isolate 沙箱，仅授权拉取隐藏测试点
- [x] 双 Web 独立入口（选手端 / 管理端，两个域名）
- [x] 完整状态机 + 租约 lease + attempt 重试
- [x] 信任链：证书身份、trust_status 审批、runtime_manifest_hash、HMAC 验签/幂等、跨节点抽查
- [x] 全链路审计、管理端总览/节点/证书/队列/重判/日志
- [x] SQLite（better-sqlite3）+ Repository 接口 + PostgreSQL 配置项
- [x] Docker 容器化部署（见 deploy/）
- [x] 服务端 Nginx + pm2 双域名生产部署（见下方「服务端部署」）

## 服务端部署（Nginx + pm2）

两个独立 Node 服务经 Nginx 反代，共享同一 SQLite 库；正式评测下沉到可信 Worker，服务端不运行参赛代码。

| 入口 | 服务端口 | 启动参数 | 职责 |
|---|---|---|---|
| 选手端 | :3001 | `APP_ENTRY=contest` | 题面/编辑器+本地预检/提交/状态/榜单 |
| 管理端 | :3002 | `APP_ENTRY=admin` | 总览/节点/证书/队列/审计/重判/日志 |

一键脚本（参考部署服务器上既有站点 blog 的模式）：

```bash
# 1) 在 deploy/ 下把占位域名改为你的真实域名（以下文件均需替换）
#    deploy/deploy-remote.sh      → DOMAIN_CONTEST / DOMAIN_ADMIN
#    deploy/nginx/*.conf.example  → server_name / root / 证书路径 / 日志路径
#    server/src/config.js         → DOMAIN_CONTEST / DOMAIN_ADMIN 默认值

# 2) 本地打包上传 + 服务器端执行（npm/pm2/证书/nginx）
#    Windows PowerShell:
powershell -ExecutionPolicy Bypass -File deploy/deploy-server.ps1
#    或在服务器上直接执行（脚本已上传至 /tmp/deploy-remote.sh）：
ssh <server> 'export PATH=/www/server/nodejs/v24.14.1/bin:/usr/bin:/bin; bash /tmp/deploy-remote.sh'
```

`deploy/deploy-remote.sh` 会依次完成：npm install → pm2 启动双服务 → 写 nginx 80/443 配置 → 签发 Let's Encrypt 证书 → reload nginx。仓库内不保留真实域名与备案号，请勿将个人信息提交到公共仓库。

## 目录结构

```
├── plan.md            三域架构与实现总纲
├── docs/api.md        接口与信任链协议
├── server/            中心控制域（双入口 Web + 调度 + 租约 + 信任链）
├── worker/            可信 Windows Judge Worker（Electron + WSL/Isolate）
└── deploy/            部署（deploy-remote.sh 一键脚本 + nginx 模板 + docker-compose）
```

> 早期 `local/` 实现已按正式申请书迁移至 `worker/`（见 `local/README.md`）。
