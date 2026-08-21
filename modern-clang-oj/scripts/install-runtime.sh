#!/usr/bin/env bash
set -Eeuo pipefail
SOURCE="${1:?validated build output directory required}"
TARGET="${2:?explicit cpp-modern-engine-v1 installation directory required}"
SOURCE="$(cd "$SOURCE" && pwd)"
TARGET_PARENT="$(dirname "$TARGET")"
mkdir -p "$TARGET_PARENT"
"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-runtime.sh" "$SOURCE"
TMP="$(mktemp -d "$TARGET_PARENT/.cpp-modern-engine-v1.install.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
cp -a "$SOURCE/." "$TMP/"
if [[ -e "$TARGET" ]]; then
  [[ "$(basename "$TARGET")" == 'cpp-modern-engine-v1' ]] || { echo 'refusing to overwrite non-modern runtime target' >&2; exit 2; }
  rm -rf "$TARGET"
fi
mv "$TMP" "$TARGET"
trap - EXIT
echo "installed verified cpp-modern-engine-v1 to $TARGET"
