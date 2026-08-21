#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$ROOT/dist}"
# shellcheck disable=SC1091
source "$ROOT/PINNED_SOURCES.env"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

clone_exact() {
  local url="$1" commit="$2" dest="$3"
  local family cache
  family="$(basename "$dest" | cut -d- -f1)"
  cache="${BROWSERJDK_SOURCE_CACHE:-}/$family.git"
  if test -n "${BROWSERJDK_SOURCE_CACHE:-}" && test -f "$cache/HEAD"; then
    git clone -q --no-hardlinks "$cache" "$dest"
    git -C "$dest" checkout -q --detach "$commit"
    test "$(git -C "$dest" rev-parse HEAD)" = "$commit"
    return
  fi
  git init -q "$dest"
  git -C "$dest" remote add origin "$url"
  git -C "$dest" fetch -q --depth 1 origin "$commit"
  git -C "$dest" checkout -q --detach FETCH_HEAD
  test "$(git -C "$dest" rev-parse HEAD)" = "$commit"
}

clone_exact "$OPENJDK_UPSTREAM_URL" "$OPENJDK_UPSTREAM_COMMIT" "$WORK/openjdk-upstream"
clone_exact "$LIBFFI_UPSTREAM_URL" "$LIBFFI_UPSTREAM_COMMIT" "$WORK/libffi-upstream"
clone_exact "$OPENJDK_PORT_URL" "$OPENJDK_PORT_COMMIT" "$WORK/openjdk-port"
clone_exact "$LIBFFI_PORT_URL" "$LIBFFI_PORT_COMMIT" "$WORK/libffi-port"
git -C "$WORK/openjdk-port" fetch -q --depth 1 origin "$OPENJDK_UPSTREAM_COMMIT"
git -C "$WORK/libffi-port" fetch -q --depth 1 origin "$LIBFFI_UPSTREAM_COMMIT"
git -C "$WORK/openjdk-port" diff --binary --full-index \
  "$OPENJDK_UPSTREAM_COMMIT" "$OPENJDK_PORT_COMMIT" > "$WORK/openjdk-emscripten-zero.patch"
git -C "$WORK/libffi-port" diff --binary --full-index \
  "$LIBFFI_UPSTREAM_COMMIT" "$LIBFFI_PORT_COMMIT" > "$WORK/libffi-wasm.patch"
cat > "$WORK/PATCH_PROVENANCE.md" <<EOF
# Port patch provenance

- OpenJDK Emscripten/Zero port: $OPENJDK_PORT_URL, commit $OPENJDK_PORT_COMMIT,
  authored by $(git -C "$WORK/openjdk-port" show -s --format='%an <%ae>' "$OPENJDK_PORT_COMMIT") on
  $(git -C "$WORK/openjdk-port" show -s --format='%aI' "$OPENJDK_PORT_COMMIT").
- libffi WASM port: $LIBFFI_PORT_URL, commit $LIBFFI_PORT_COMMIT,
  authored by $(git -C "$WORK/libffi-port" show -s --format='%an <%ae>' "$LIBFFI_PORT_COMMIT") on
  $(git -C "$WORK/libffi-port" show -s --format='%aI' "$LIBFFI_PORT_COMMIT").

Patch SHA-256 values are recorded in source-bundle-manifest.json.
EOF

mkdir -p "$WORK/browserjdk-oj"
cp -a "$ROOT/src" "$ROOT/patches" "$ROOT/Dockerfile.build" "$ROOT/build-in-container.sh" \
  "$ROOT/build-runtime.sh" "$ROOT/install-runtime.sh" "$ROOT/make-source-bundle.sh" \
  "$ROOT/verify-reproducible-builds.sh" \
  "$ROOT/PINNED_SOURCES.env" "$ROOT/LICENSE" "$ROOT/README.md" \
  "$ROOT/BUILDING.md" "$ROOT/THIRD_PARTY_LICENSE_MATRIX.md" \
  "$ROOT/THIRD_PARTY_NOTICES.md" "$ROOT/SOURCE_DISTRIBUTION.md" \
  "$ROOT/runtime-manifest.json" \
  "$WORK/browserjdk-oj/"

OPENJDK_PATCH_SHA="$(sha256sum "$WORK/openjdk-emscripten-zero.patch" | cut -d' ' -f1)"
LIBFFI_PATCH_SHA="$(sha256sum "$WORK/libffi-wasm.patch" | cut -d' ' -f1)"
LIBFFI_AUTOCONF_PATCH_SHA="$(sha256sum "$ROOT/patches/libffi-autoconf-2.72.patch" | cut -d' ' -f1)"
ARCHIVE="$OUT/browserjdk-oj-source.tar.gz"
EPOCH="${SOURCE_DATE_EPOCH:-1770336000}"
# The bundle carries clean official upstream trees plus auditable port diffs;
# repository transport metadata is neither corresponding source nor stable.
rm -rf "$WORK/openjdk-upstream/.git" "$WORK/libffi-upstream/.git"
# Keep both the tar entry metadata and the gzip header independent of the
# wall-clock time. This makes repeated source-bundle generation hash-stable.
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner \
  -cf - -C "$WORK" browserjdk-oj openjdk-upstream libffi-upstream \
  openjdk-emscripten-zero.patch libffi-wasm.patch PATCH_PROVENANCE.md | gzip -n > "$ARCHIVE"
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
cat > "$OUT/source-bundle-manifest.json" <<EOF
{"sourceBundle":"$(basename "$ARCHIVE")","sha256":"$ARCHIVE_SHA","openjdkUpstreamCommit":"$OPENJDK_UPSTREAM_COMMIT","openjdkPortCommit":"$OPENJDK_PORT_COMMIT","openjdkPatchSha256":"$OPENJDK_PATCH_SHA","libffiUpstreamCommit":"$LIBFFI_UPSTREAM_COMMIT","libffiPortCommit":"$LIBFFI_PORT_COMMIT","libffiPatchSha256":"$LIBFFI_PATCH_SHA","libffiAutoconfPatchSha256":"$LIBFFI_AUTOCONF_PATCH_SHA","emscriptenVersion":"$EMSDK_VERSION","emscriptenCommit":"$EMSDK_COMMIT","emscriptenImageDigest":"$EMSDK_AMD64_DIGEST","buildJdkVersion":"$BUILD_JDK_VERSION","buildJdkSha256":"$BUILD_JDK_SHA256"}
EOF
printf '%s  %s\n' "$ARCHIVE_SHA" "$(basename "$ARCHIVE")"
