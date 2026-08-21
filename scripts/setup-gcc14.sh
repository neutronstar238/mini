#!/usr/bin/env bash
# Install the versioned GCC14 reference without changing the system default or
# the frozen GCC11 judge commands.
set -eu

PIN="${GCC14_PIN_VERSION:-14.2.0-4ubuntu2~24.04.1}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash scripts/setup-gcc14.sh" >&2
  exit 1
fi

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  "gcc-14=${PIN}" \
  "g++-14=${PIN}"

test "$(command -v gcc-14)" = /usr/bin/gcc-14
test "$(command -v g++-14)" = /usr/bin/g++-14
gcc-14 --version | head -n 1
g++-14 --version | head -n 1

echo "GCC14_REFERENCE_READY"
echo "Legacy gcc/g++ alternatives were not changed."
