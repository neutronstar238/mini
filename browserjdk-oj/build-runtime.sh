#!/usr/bin/env bash
# BrowserJDK reproducible Docker build entry point.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$ROOT/runtime}"
IMAGE="browserjdk-oj-build:emsdk-5.0.2"

command -v docker >/dev/null 2>&1 || { echo "BUILD_REQUIRED: Docker is not available" >&2; exit 2; }
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

docker build --platform linux/amd64 --pull=false -t "$IMAGE" -f "$ROOT/Dockerfile.build" "$ROOT"
docker run --rm --platform linux/amd64 \
  --mount "type=bind,src=$ROOT,dst=/src,readonly" \
  --mount "type=bind,src=$OUT,dst=/out" \
  -e SOURCE_DATE_EPOCH=1770336000 \
  "$IMAGE" /src/build-in-container.sh /out
