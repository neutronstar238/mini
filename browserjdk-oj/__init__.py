"""browserjdk-oj — 自主 Browser Java 21 Runtime (Project Scaffold)

=========================================================
License & Redistribution Status (this file itself): MIT
=========================================================

This project is an independent engineering effort to build a browser Java 21
runtime for the Mini-OJ contest platform, using only components with
**explicitly identifiable redistribution licenses**.

The core technology idea (OpenJDK 21 Zero interpreter → WebAssembly via
Emscripten, with a persistent in-JVM CompileServer and a fresh
MemoryClassLoader per user submission) is informed by the JavaBox PoC
(https://github.com/bmarti44/javabox) which we used as a TECHNICAL_REFERENCE
ONLY during Phase 6 Milestone-1 validation.

We DO NOT copy any source code, build scripts, glue code (jvm-main.c /
CompileServer.java / web/ editor glue), or prebuilt binaries from JavaBox.
Every line in this repository is original work or carries an explicit
upstream license header (see THIRD_PARTY_LICENSE_MATRIX.md).

WHY AN INDEPENDENT PROJECT?
- JavaBox has no LICENSE file (verified 404 on
  https://raw.githubusercontent.com/bmarti44/javabox/main/LICENSE).
- Its prebuilt artifacts ship from a personal Cloudflare Worker
  (javabox-demo.brian-fec.workers.dev) with no hash verification.
- Mini-OJ may be deployed as a public contest platform and redistributed
  to other servers; we cannot ship an artifact of unclear provenance.

UPSTREAM LICENSES (all explicit, all permissive or classpath-exception):
- OpenJDK 21u (jdk-21+GA): GPLv2 + Classpath Exception
- Emscripten SDK 5.0.2: MIT / University of Illinois/NCSA (dual)
- libffi 3.4.6: permissive (BSD-like / MIT-compatible)

See THIRD_PARTY_LICENSE_MATRIX.md for per-file attestation.

=========================================================
"""

__all__ = [
    "__version__",
    "RUNTIME_ID",
    "STATUS",
]

__version__ = "0.2.0-checkpoint2"
RUNTIME_ID = "java21-browserjdk-compat-v2"
STATUS = "CHECKPOINT_2_CANDIDATE"
