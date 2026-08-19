# Mini-OJ 可信 Windows Judge Worker（Electron APP）

可信执行域（Trusted Execution Domain）。正式评测只在**本 Worker 的 WSL2 + Ubuntu + Isolate 沙箱**中运行，
隐藏测试点仅授权可信 Worker 拉取；中心控制面（server）正常路径不运行参赛代码。

## 运行方式

### 方式一：Electron APP（桌面，托盘运行）

```bash
cd worker
npm install            # 安装 electron
npm start              # 系统托盘 + 状态面板
```

### 方式二：headless（无 GUI / 服务器 / 联调演示）

```bash
cd worker
# 首次注册（需管理员在管理端生成的注册码）
node judge/headless.js --register OJ-XXXX --server http://<服务器>:3000
# 运行
node judge/headless.js --server http://<服务器>:3000
```

## 环境要求

- **Windows 10/11** + **WSL2**
- **Ubuntu 22.04** 发行版（正式环境；本机演示可用 Ubuntu-24.04，见下）
- WSL 内安装 g++ 与 python3：
  ```bash
  sudo apt update && sudo apt install -y g++ python3
  ```
- （可选，正式隔离）安装 **Isolate 沙箱**：
  ```bash
  sudo apt install -y isolate   # 若仓库无此包，从 https://github.com/ioi/isolate 编译安装
  ```
- 发行版通过环境变量指定（默认 `Ubuntu-22.04`）：
  ```powershell
  $env:MINIOJ_WSL_DISTRO = "Ubuntu-24.04"   # 本机演示改用已装发行版
  node judge/headless.js --server http://localhost:3000
  ```

## 信任与安全

| 能力 | 说明 |
|---|---|
| 证书身份 | 注册码换取 `worker_id + cert_id + secret`（`worker.json`，仅存本机） |
| 审批门槛 | `trust_status=pending` 时**无法**领取隐藏测试点，需管理员 approve |
| 运行时自检 | 启动/每任务前计算 `runtime_manifest_hash`（对评测脚本的 SHA-256），上报服务器比对 |
| 任务验签 | 收到任务先验 HMAC（含 lease/nonce），防篡改/重放 |
| 报告签名 | 结果全字段 HMAC 回传，服务端验签+幂等 |
| 主动对抗 | 检测调试器/可疑进程，异常拒绝评测 |

## 结构

```
worker/
├── main.js                 # Electron 主进程（托盘+面板）
├── ui/index.html           # 状态面板
├── agent/
│   ├── core.js             # 核心 Agent：注册/心跳/收任务/评测/回传
│   └── net.js              # 零依赖 HTTP 客户端
├── judge/
│   ├── wsl-judge.js        # WSL + Isolate 沙箱评测核心（路径转换/回退）
│   └── headless.js         # headless 入口
└── security/
    └── worker-security.js  # 证书/自检/签名/主动对抗
```

> 边界声明：Electron Worker 是可信评测的执行载体；正式隔离依赖 WSL+Isolate 沙箱，
> Windows 侧仅做资源管理与通信，不运行参赛代码。
