# BrowserJDK OJ Runtime

Status: `CHECKPOINT_2_CANDIDATE`; `REDISTRIBUTABLE=false` pending project-owner
and legal review. This directory builds a real OpenJDK 21.0.10+7 Zero JVM for
WebAssembly. Production loads only the self-built runtime and never falls back
to JavaBox.

The implementation has three physically distinct shared-memory rings:

- BJOJ/1 control requests (JavaScript to CompileServer)
- BJOJ/1 control responses (CompileServer to JavaScript)
- user program stdin (JavaScript to `System.in`)

The native JVM entry, JSR-199 CompileServer, BJOJ/1 protocol, stdin bridge and
JavaScript adapter are independent BrowserJDK implementations. No JavaBox root
source, build script, loader, CompileServer or prebuilt asset is present.

Build with `./build-runtime.sh`. Install only after manifest verification with
`./install-runtime.sh`. Create the corresponding source archive with
`./make-source-bundle.sh`. Exact commits and container identities are in
`PINNED_SOURCES.env`; license scope and obligations are in `LICENSE`,
`THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSE_MATRIX.md`, and
`SOURCE_DISTRIBUTION.md`.

Generated runtime assets are:

- `browserjdk.wasm`
- `browserjdk.data`
- `browserjdk.mjs`
- `browserjdk.worker.mjs` (required by Emscripten pthread startup)
- `loader.mjs`
- `runtime-manifest.json`
- `LICENSE`
- `THIRD_PARTY_NOTICES.md`
- `LINKED_COMPONENTS.json`

Large generated assets are ignored by Git and installed to
`server/public/js/runtime/java21-browserjdk-compat-v2/`.
