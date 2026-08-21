#!/usr/bin/env bash
# ============================================================
# scripts/setup-gcc11.sh
#
# 冻结真正的 GCC 11 参考环境（在 yqzl 服务器 / 或 WSL Ubuntu 内）。
# 用途：Browser C++ Runtime 兼容性测试的正式 Reference 编译环境。
#   g++-11 / gcc-11  （-std=c++11 / -std=c11）
#
# 背景：
#   宿主机默认只有 MinGW GCC 15.x，不能作为 GCC11 的近似替代。
#   本项目兼容性对照必须以「真正 GCC 11」为准（详见 compat-tests/reference.json）。
#
# 当前已用于 yqzl 服务器（Ubuntu 24.04.4 LTS），通过 SSH 调用：
#   ssh yqzl-server "sudo bash -s < scripts/setup-gcc11.sh"
#   # 服务器 apt 网络畅通，无需换镜像；版本已实测 11.5.0-1ubuntu1~24.04.1
#
# 若需在 WSL 内复现：
#   wsl -d Ubuntu-24.04 -u root -- bash -c "$(cat scripts/setup-gcc11.sh)"
#
# 环境变量：
#   GCC11_PIN_VERSION   : 可选，指定固定版本（默认 11.5.0-1ubuntu1~24.04.1）
#   APT_MIRROR          : 可选，apt 镜像，例如 https://mirrors.tuna.tsinghua.edu.cn/ubuntu
#                         默认使用官方 archive.ubuntu.com（WSL NAT 受限时需指定镜像）
# ============================================================
set -eu

PIN="${GCC11_PIN_VERSION:-11.5.0-1ubuntu1~24.04.1}"

echo "== 1) 切换到 root（WSL 默认用户若非 root）=="
if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root 权限，请用: sudo bash scripts/setup-gcc11.sh"
  exit 1
fi

echo "== 2) 配置 apt 镜像（可选）=="
if [ -n "${APT_MIRROR:-}" ]; then
  echo "使用镜像: ${APT_MIRROR}"
  cat > /etc/apt/sources.list <<EOF
deb ${APT_MIRROR} noble main restricted universe multiverse
deb ${APT_MIRROR} noble-updates main restricted universe multiverse
deb ${APT_MIRROR} noble-security main restricted universe multiverse
EOF
fi

echo "== 3) apt update =="
apt-get update -y -qq

echo "== 4) 安装 gcc-11 / g++-11（固定版本 ${PIN}）=="
DEBIAN_FRONTEND=noninteractive \
apt-get install -y -qq \
  gcc-11=${PIN} \
  g++-11=${PIN} \
  gcc-11-base=${PIN} \
  cpp-11=${PIN}

echo "== 5) 建立 gcc-11/g++-11 的 unversioned 软链（仅当不存在）=="
if [ ! -e /usr/local/bin/gcc-11 ]; then
  ln -s /usr/bin/gcc-11 /usr/local/bin/gcc-11
fi
if [ ! -e /usr/local/bin/g++-11 ]; then
  ln -s /usr/bin/g++-11 /usr/local/bin/g++-11
fi

echo "== 6) 验证版本 =="
gcc-11 --version | head -1
g++-11 --version | head -1
echo
echo "安装完成。参考环境固定命令："
echo "  gcc-11  -std=c11    <file.c>"
echo "  g++-11  -std=c++11  <file.cpp>"
