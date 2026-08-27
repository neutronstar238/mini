# Mini-OJ 部署配置

生产部署需要人工填写的目标参数集中在一个本地文件：`deploy/deploy.env`。仓库只提交无敏感信息的模板 `deploy/deploy.env.example`，实际配置已被 `.gitignore` 排除。

## 快速使用

在仓库根目录执行：

```powershell
Copy-Item .\deploy\deploy.env.example .\deploy\deploy.env
notepad .\deploy\deploy.env
pwsh -File .\deploy\deploy-server.ps1 -ConfigFile .\deploy\deploy.env -ValidateOnly
pwsh -File .\deploy\deploy-server.ps1 -ConfigFile .\deploy\deploy.env
```

通常只需填写 `SERVER_HOST`、`DOMAIN_CONTEST` 和 `DOMAIN_ADMIN`。其余字段已经给出项目默认值，仅在服务器目录、端口、进程名或工具链位置不同时修改。

配置文件使用一行一个 `KEY=VALUE` 的格式，允许空行、整行注释以及单引号或双引号包裹的值，不执行命令替换或变量展开。未知字段和重复字段会直接报错。`LOCAL_DIR` 的相对路径以配置文件所在目录为基准。

## 配置项

| 字段 | 用途 |
|---|---|
| `SERVER_HOST` | SSH 主机名、SSH config 别名或 `user@host` |
| `DOMAIN_CONTEST` / `DOMAIN_ADMIN` | 选手端与管理端域名 |
| `LOCAL_DIR` | 本地 `server/` 发布源 |
| `REMOTE_WEB_ROOT` / `REMOTE_BACKUP_ROOT` / `REMOTE_SECRETS_DIR` | 远端应用、备份和私密配置目录 |
| `REMOTE_NODE_BIN` | 远端 Node.js 与 PM2 所在目录 |
| `CONTEST_PORT` / `ADMIN_PORT` | 两个仅监听服务器内部的应用端口 |
| `PM2_CONTEST_NAME` / `PM2_ADMIN_NAME` | PM2 进程名 |
| `C_COMPILER` / `CPP_COMPILER` | C11/C++11 权威判题编译器 |
| `JAVA_JAVAC_BIN` / `JAVA_BIN` | Java 21 权威判题工具链 |
| `NGINX_VHOST_DIR` / `NGINX_LOG_DIR` / `NGINX_BIN` / `CERTBOT_BIN` | 首次服务器初始化使用的 Nginx 与 Certbot 设置 |
| `COMPOSE_HTTP_PORT` | 可选 Docker Compose 入口端口；PM2 生产发布不使用 |

`deploy-server.ps1` 的显式命令行参数仍然兼容，并且优先级高于配置文件，适合 CI 做单次覆盖。正常人工发布应只使用配置文件，避免参数散落在历史命令中。

## 首次初始化与密钥

`deploy/deploy-remote.sh` 用于首次服务器初始化，也读取同一份配置：

```bash
DEPLOY_VALIDATE_ONLY=1 DEPLOY_CONFIG_FILE=/secure/path/deploy.env bash deploy/deploy-remote.sh
DEPLOY_CONFIG_FILE=/secure/path/deploy.env bash deploy/deploy-remote.sh
```

配置文件不保存 `JWT_SECRET`、`HMAC_SECRET` 或 `INTERNAL_API_SECRET`。两个部署脚本都会在 `REMOTE_SECRETS_DIR/mini-oj.env` 中复用或首次生成这些密钥，并把文件权限设为 `0600`。不要把该服务器私有文件下载或提交到 Git。

日常增量发布使用 `deploy-server.ps1`。首次初始化脚本会配置 PM2、Nginx 和证书，但不会替代发布归档上传步骤。

可选 Docker Compose 编排也读取同一份参数文件：

```bash
docker compose --env-file deploy/deploy.env -f deploy/docker-compose.yml config
docker compose --env-file deploy/deploy.env -f deploy/docker-compose.yml up -d
```

Compose 从 `REMOTE_SECRETS_DIR/mini-oj.env` 读取同一组服务器密钥，不再包含 `change-me` 一类默认凭据。
