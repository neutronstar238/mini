# Reproducible build

Prerequisite: Docker Desktop with Linux/amd64 containers and network access to
the repositories named in `PINNED_SOURCES.env`.

```sh
./build-runtime.sh ./runtime
./install-runtime.sh ./runtime ../server/public/js/runtime/java21-browserjdk-compat-v2
./make-source-bundle.sh ./dist
```

The Docker image is pinned by digest. It downloads the pinned Temurin build JDK
and verifies its SHA-256 inside the image. Every source checkout is detached at
an exact commit and verified with `git rev-parse`. The build creates auditable
binary diffs against the official OpenJDK/libffi base commits and records their
SHA-256 values in the runtime manifest.

For the Checkpoint 1 reproducibility gate, run two containers with different
empty output directories and no build-volume mounts:

```sh
docker run --rm --platform linux/amd64 --mount type=bind,src="$PWD",dst=/src,readonly \
  --mount type=bind,src="$PWD/.build/a",dst=/out browserjdk-oj-build:emsdk-5.0.2 \
  /src/build-in-container.sh /out
docker run --rm --platform linux/amd64 --mount type=bind,src="$PWD",dst=/src,readonly \
  --mount type=bind,src="$PWD/.build/b",dst=/out browserjdk-oj-build:emsdk-5.0.2 \
  /src/build-in-container.sh /out
```

Compare all files listed in both runtime manifests. The linker map is retained
as build evidence; `LINKED_COMPONENTS.json` is generated from it instead of
assuming which Emscripten system libraries were linked.

After both builds finish, verify the recorded hashes and linker evidence with:

```sh
./verify-reproducible-builds.sh .build/a .build/b
```
