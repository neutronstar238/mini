# Java Browser Production Report — Checkpoint 1

The production Java path now uses the self-built `java21-browserjdk-compat-v1` assets and local `loader.mjs` exclusively. Asset download, cache, progress, retry, and SHA-256 verification remain integrated through the existing runtime asset manager. A missing or invalid asset returns `BUILD_REQUIRED / NOT_READY`; the Worker has no JavaBox fallback.

Real Chrome `151.0.7922.170` booted BrowserJDK `21.0.10+7-LTS` in 1897 ms on the final verification run and completed IO `12/12` plus ACM `12/12` against the OpenJDK 21.0.10 server baseline. Current state is `TECHNICALLY_VALIDATED=true`, `REDISTRIBUTABLE=false`.

See [JAVA_PHASE7_CHECKPOINT_1.md](JAVA_PHASE7_CHECKPOINT_1.md) for asset hashes, source pins, licensing status, and the exact acceptance boundary.
