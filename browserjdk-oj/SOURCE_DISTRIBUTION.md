# Corresponding source distribution

`java21-browserjdk-compat-v2` is distributed only with corresponding source.
The source bundle contains the exact OpenJDK 21u tree, the exact Emscripten/Zero
port commit (including its commit metadata), the exact libffi tree and WASM
port commit, BrowserJDK's own native/Java/JavaScript glue, this Docker build
definition, the install/source-bundle helpers, the checkpoint manifest, and the
license/notices/audit files.

Create it with `./make-source-bundle.sh ./dist`. The script verifies every
commit and records both the source archive SHA-256 and the two upstream patch
SHA-256 values in `source-bundle-manifest.json`.
The source archive also includes `verify-reproducible-builds.sh`, which checks
both clean-build manifests, every recorded asset hash, and linker evidence.

Publishing the runtime without the corresponding bundle (or a written offer
that satisfies GPLv2) is not permitted by this project's release process.
Classpath Exception scope is per upstream source-file header. It is not applied
to an OpenJDK file that does not contain the exception, and it is not asserted
for the WebAssembly bundle as a whole.
