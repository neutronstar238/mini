# 在线评测系统（OJ）—— Chrome 浏览器本地预检与可信边缘评测分布式方案
## 项目研究计划 / 实现总纲

> 依据《在线评测系统（OJ）——Chrome 浏览器本地预检与可信边缘评测分布式方案项目立项申请书》正式立项。
> 项目为**单人项目**，8 天逐日推进，以 Git 提交管理并每日自验收。
> 参考 UI 风格：开源仓库 [CCPCOJ](https://github.com/CSGrandeur/CCPCOJ)（Bootstrap 3 扁平化、深色导航条、左侧边栏）。

---

## 1. 背景与问题

传统 OJ 的痛点：
- **服务器集中评测压力大**：每次提交都在服务器编译运行，高峰拥堵、排队延迟高、扩容成本高；
- **评测公平性难保证**：选手本机预检（自装编译器）易被操纵/隐藏，无法采信，与正式结果割裂；
- **单点信任**：评测机一旦被篡改即影响全局结果，缺少可审计、可抽检的信任体系。

## 2. 核心创新（申请书立项要点）

**本方案把评测拆成"浏览器本地预检 + 可信边缘评测"两条解耦路径，服务器正常路径不运行参赛代码：**

1. **本地预检（浏览器 WebAssembly，不可信域）**：选手在 Chrome 内通过 WASM 编译器
   （C/C++ 走 Clang/LLD-to-Wasm，Python 走 Pyodide）对**公开样例**做本地编译与试跑，
   不安装任何 Local Agent，**不接触隐藏测试点**。预检通过即上传，减轻服务器负担。
2. **可信边缘评测（WSL 沙箱，可信执行域）**：正式评测只在**可信 Windows Judge Worker
   的 WSL 2 + Ubuntu 22.04 + Isolate 沙箱**中运行，隐藏测试点仅授权可信 Worker 拉取。
3. **三域解耦 + 中心仲裁**：服务器只负责调度/租约/验签/仲裁/榜单，**不运行参赛代码**。

## 3. 总体架构（三域）

```
┌──────────────────── 不可信域 (Untrusted) ────────────────────┐
│  Contestant Chrome 选手端 Web (student 域名)                   │
│   ├─ 题面/编辑器/提交/状态/榜单 (Web)                          │
│   └─ 本地预检 Web Worker: WASM Clang(C/C++) + Pyodide(Python) │
│       对公开样例试跑 → LocalVerification(本地预检)             │
└──────────────┬────────────────────────────────────────────────┘
               │ HTTPS/SSE
┌──────────────▼──────────────── 中心控制域 (Central) ─────────┐
│  OJ Server (管理端 admin 域名 + 选手端 contest 域名)            │
│   ├─ 用户/权限 · 题目(隐藏测试点加密) · 提交状态机 · 榜单        │
│   ├─ Scheduler: 租约(lease)/attempt 分配 · 跨节点抽查调度       │
│   ├─ Trust: 证书身份 · trust_status 审批 · 验签/幂等/仲裁        │
│   ├─ Audit: 全链路审计 · 异常自动重判                           │
│   └─ 存储: SQLite(better-sqlite3) + Repository + PG 配置项     │
└──────────────┬────────────────────────────────────────────────┘
               │ mTLS + 任务签名(lease/nonce) + 租约心跳
┌──────────────▼──────────────── 可信执行域 (Trusted) ──────────┐
│  Trusted Windows Judge Worker APP (Electron)                   │
│   ├─ WSL 2 + Ubuntu 22.04 + Isolate 隔离沙箱                    │
│   ├─ 仅授权 Worker 拉取隐藏测试点                              │
│   ├─ 运行时自检(runtime_manifest_hash) · 证书身份 · 心跳        │
│   └─ 结果签名回传 · 接受跨节点抽查重判                          │
└────────────────────────────────────────────────────────────────┘
```

**两条路径**：
- 选手本地预检通过 → 提交 → 服务器入队 → 调度到可信 Worker → 正式评测 → 结果广播榜单。
- 服务器**正常路径不运行参赛代码**，只在可信 Worker 的 Isolate 沙箱内执行。

## 4. 双 Web 入口（两个独立域名）

| 入口 | 域名示例 | 定位 | 页面 |
|---|---|---|---|
| 选手端 | `contest.example.com` | 面向参赛者 | 登录/题目/编辑器+本地预检/提交/状态/榜单 |
| 管理端 | `admin.example.com` | 面向管理员 | 总览/节点管理/证书/任务队列/审计/重判/日志 |

两者**逻辑隔离、独立入口**。管理端默认不开放注册，仅管理员可登录；选手端不暴露评测机
内部接口。同源服务端通过**路由前缀 + 独立中间件**实现双域名区分，部署时可经
Nginx 按 `ServerName` 分发到同一应用（`contest`/`admin` 两个入口上下文）。

## 5. 提交状态机（正式定义）

```
SUBMITTED(已提交/本地预检标记)
  └→ PENDING(排队中)
       └→ LEASED(已租约给 Worker)
            ├→ COMPILING(编译中)
            ├→ RUNNING(评测中)
            └→ (租约超时/Worker 异常 → 回到 PENDING，attempt+1)
                 └→ VERIFYING(跨节点抽查/复核)
                      └→ AC | WA | TLE | MLE | RE | CE | SE(系统错误)
```

- `attempt`：同一次提交的重试次数（lease 过期、验签失败、抽查不符时递增，达上限判定 SE/拒判）；
- `lease`：Worker 领取任务的一次性租约（含 nonce + 有效期），防止任务重复领取与重放。

## 6. 任务 JSON 与信任链协议

### 6.1 任务下发（server → worker）

```jsonc
{
  "task_id": "uuid", "submission_id": "uuid", "attempt": 1,
  "language": "cpp" | "python",
  "code": "选手代码",
  "problem": {
    "time_limit_ms": 1000, "memory_limit_mb": 256,
    "testcases": [ { "id":1, "input":"…", "answer":"…" } ]   // 隐藏测试点，仅授权可信 Worker
  },
  "worker_id": "可信WorkerID", "tier": "trusted",
  "lease": { "lease_id": "uuid", "nonce": "随机", "expires_at": 1755563947012 },
  "runtime_manifest_hash": "sha256",   // 期望的运行时清单哈希（防止 Worker 篡改运行环境）
  "trust_status": "approved",
  "sig": "HMAC-SHA256(worker_secret, 规范化串)"
}
```

### 6.2 结果回传（worker → server）

```jsonc
{
  "task_id": "…", "submission_id": "…", "attempt": 1,
  "status": "AC", "cases": [ {id,status,time_ms,memory_kb} ],
  "runtime_manifest_hash": "sha256",    // Worker 报告的实际运行时哈希
  "worker_id": "…", "lease_id": "…", "nonce": "…",
  "env": { "wsl_version":"…","ubuntu":"22.04","isolate":"…","self_hash":"…" },
  "sig": "HMAC-SHA256"
}
```

### 6.3 信任与安全闭环

| 机制 | 说明 |
|---|---|
| 证书身份 | Worker 注册后由管理员签发**证书/密钥对**（mTLS 可选，HTTP+HMAC 亦可），凭 `worker_id` 访问 |
| trust_status | Worker 需 `approved`（管理员审批）后才可领取隐藏测试点；`suspended/revoked` 自动下线 |
| 租约 lease | 任务一次性租约（lease_id+nonce+expires_at），服务端缓存防重放；过期自动回 PENDING |
| runtime_manifest_hash | 服务器下发期望运行时哈希，Worker 上报实际哈希，不一致→异常告警并触发重判 |
| 跨节点抽查 | 服务器可对同一 submission 下发至第二个可信 Worker 重判，比对结果一致性 |
| 验签/幂等 | 结果全字段 HMAC 验签；重复回传（同 lease_id）幂等拒绝 |
| 审计 | 全链路事件落库（下发/心跳/回传/抽查/重判/异常），管理端可追溯 |

## 7. 浏览器本地预检（不可信域，不接触隐藏数据）

- **C/C++**：`contest/public/js/wasm/` 内置 Clang-WASM 编译器（原型选用可分发 WASM 工具链），
  选手代码 + 公开样例输入在 Web Worker 内编译为 WASM 并执行比对；
- **Python**：`Pyodide` Web Worker 运行 Python 并比对公开样例；
- 预检只读公开 `samples`，**不请求**隐藏 `testcases`；结果作为 `localVerification` 标记随提交上报；
- 环境检测页展示是否支持 WASM/Pyodide，不满足则提示但仍可提交（正式评测仍走可信 Worker）。

> 实现说明：WASM C 编译器体积较大，本实现以「C/C++ 通过 WASM 原型 + Python 经 Pyodide」双 Worker
> 提供本地预检；若无法完整内嵌 Clang-WASM，则退化为「本地样例自检脚本提示」并在文档如实声明边界。

## 8. 可信 Windows Judge Worker（Electron APP）

- **Electron 外壳**：系统托盘 + 注册证书 + 启动自检 + 心跳 + 收任务/回传；
- **评测沙箱**：调用 `wsl -d Ubuntu-22.04 -- bash -c "isolate ..."`，Isolate 提供 CPU 时间/
  内存/墙钟/输出限制与进程隔离（Linux 原生，比 Windows taskkill 更可信）；
- **运行时自检**：开机与每任务前计算 `runtime_manifest_hash`（对 `wsl.conf`/Isolate 配置/
  评测脚本的 SHA-256），上报服务器比对；
- **证书身份**：注册换取 `worker_id + secret`（或证书），心跳携带环境指纹与信任状态。
- **Electron 界面**：最小化到托盘，主窗口显示连接状态/最近任务/日志/自检结果。

> 边界声明：Electron Worker 提供可信评测的执行载体；正式评测隔离依赖 WSL+Isolate 沙箱，
> Windows 侧仅做资源管理与通信，不运行参赛代码。

## 9. 服务端（中心控制域）数据与接口

- **存储**：SQLite（better-sqlite3 事务化，WAL）+ Repository 统一接口 + PostgreSQL 配置切换；
- **认证**：选手/管理员双角色；管理端独立中间件与路由前缀；
- **接口分组**：
  - 选手端：`/contest/**`（登录/题目/提交/状态/榜单）
  - 管理端：`/admin/**`（总览/节点/证书/队列/审计/重判/日志）
  - 评测协议：`/worker/**`（注册/证书/task 下发/心跳/回传/抽查）
- **状态广播**：SSE 实时推送提交状态与榜单变化。

## 10. 里程碑（8 天单人，逐日自验收）

| 日程 | 内容 |
|---|---|
| D1 | 立项冻结：三域架构、双入口、任务JSON/状态机/信任链契约；重建 plan.md |
| D2 | server 双入口：选手端(contest)+管理端(admin) 独立路由与页面、用户/权限/题目/提交 |
| D3 | 中心控制面：状态机(S→P→L→C→R→V→verdict)、租约 lease/attempt、Scheduler 调度 |
| D4 | 信任链：Worker 注册/证书、trust_status 审批、runtime_manifest_hash、验签/幂等、跨节点抽查 |
| D5 | 选手端预检：WASM C/C++ + Pyodide Python Web Worker、本地预检标记、环境检测 |
| D6 | 可信 Worker APP：Electron 外壳 + WSL/Isolate 调用 + 运行时自检 + 报告签名 |
| D7 | 管理端完整后台：总览/节点/证书/队列/审计/重判/日志 |
| D8 | 文档、部署、双节点一致性/安全注入验收 |

## 11. 目录结构

```
e:/mini/
├── plan.md                 # 本文档
├── README.md               # 快速启动（双入口 + Worker）
├── docs/api.md             # 三域接口与信任链协议
├── server/                 # 中心控制域（Node.js + Express + SQLite）
│   ├── src/
│   │   ├── app.js          # 双入口路由装载（contest/admin/worker）
│   │   ├── config.js
│   │   ├── middleware/     # auth(选手) + authAdmin + requireRole
│   │   ├── routes/
│   │   │   ├── contest/    # 选手端：auth/problems/submissions/rank
│   │   │   ├── admin/      # 管理端：overview/nodes/certs/queue/audit/rejudge
│   │   │   └── worker/     # 评测协议：register/lease/report/heartbeat/spotcheck
│   │   ├── services/       # state-machine / scheduler / trust / rejudge
│   │   ├── store/          # Repository: sqlite + pg 配置
│   │   ├── security/       # HMAC / cert / nonce / lease
│   │   ├── sse/            # hub
│   │   └── seed.js
│   ├── views/
│   │   ├── contest/        # 选手端页面
│   │   └── admin/          # 管理端页面
│   ├── public/
│   │   ├── css/            # ccpcoj.css / login.css
│   │   └── js/
│   │       ├── contest/    # 选手端 js
│   │       ├── admin/      # 管理端 js
│   │       └── wasm/       # 本地预检 WASM/Pyodide 资源
│   └── Dockerfile
├── deploy/                 # docker-compose + nginx（双域名 ServerName 分发）
├── scripts/demo.ps1
└── worker/                 # 可信 Windows Judge Worker（Electron）
    ├── package.json
    ├── main.js             # Electron 主进程
    ├── preload.js
    ├── judge/              # WSL + Isolate 沙箱调用
    ├── security/           # 证书/自检/签名
    └── ui/                 # 托盘/主窗口
```

## 12. 验收标准

1. 双域名：`contest.*` 选手端与 `admin.*` 管理端各自独立可访问、逻辑隔离；
2. 选手本地预检：公开样例在浏览器 WASM/Pyodide 试跑通过后提交；
3. 正式评测仅经可信 Worker（WSL+Isolate）；服务器正常路径不运行参赛代码；
4. 状态机完整流转，租约超时自动重排，attempt 正确累加；
5. 信任链：worker 未审批无法拉隐藏测试点；runtime_manifest_hash 不一致触发告警与重判；
6. 跨节点抽查：双 Worker 结果一致性校验，不一致进入审计重判；
7. 管理端后台可查节点/证书/队列/审计/重判/日志；
8. 文档齐备，双节点一致性与安全注入（签名伪造/重放/篡改/证书吊销）验收通过。
