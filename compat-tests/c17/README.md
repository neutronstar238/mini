# C17 Modern Browser Phase 8 Beta corpus

The Phase 8 corpus exercises the `c17-gcc14-compat-v2` profile through
`cpp-modern-engine-v2` and compares Browser Clang 19/WASI, GCC 14.2/Linux,
and checked expected output. Formal Submit remains disabled.

The scoreable matrix contains 36 positive feature cases, 30 ACM/OJ cases,
15 negative compile-error cases, and 10 warning-without-compile-error cases.
Four UB/implementation-sensitive cases are evidence-only and excluded from
compatibility and correctness rates.

Run the Chrome M5–M7 harness from the repository root:

```text
node compat-tests/c17/run-c17-compatibility.mjs --reuse-server --browser --strict
```
