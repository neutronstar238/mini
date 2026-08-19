# ============================================================
# Mini-OJ Server —— 多阶段构建
# 阶段1：安装依赖（含 better-sqlite3 原生编译）
# 阶段2：运行镜像（仅复制产物，减小体积）
# ============================================================
FROM node:20-bookworm-slim AS build

# better-sqlite3 需要原生编译工具链
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com \
    && npm install --omit=dev

FROM node:20-bookworm-slim

WORKDIR /app
# 时区与运行环境
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=3000 \
    HOST=0.0.0.0

# 从构建阶段复制 node_modules（better-sqlite3 原生模块随镜像预编译）
COPY --from=build /app/node_modules ./node_modules
COPY src ./src
COPY views ./views
COPY public ./public

# 数据目录（挂载卷）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "src/app.js"]
