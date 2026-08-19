# local/ 目录说明

本目录为早期「Windows 本地评测机」实现，已按正式《项目立项申请书》迁移至

## `../worker/`（可信 Windows Judge Worker APP）

正式架构为**三域解耦**（见 `../plan.md`）：

- **不可信域**：选手 Chrome 内 WebAssembly 本地预检（`server/views/contest` + Pyodide/WASM）
- **中心控制域**：`server/`（选手端 + 管理端双 Web，Scheduler/租约/验签/审计）
- **可信执行域**：`../worker/`（Electron Worker + WSL2 + Isolate 沙箱，仅授权拉取隐藏测试点）

可信 Worker 的启动方式见 `../worker/README.md`。
