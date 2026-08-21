# Java 21 Browser IO Suite — Checkpoint 1

Environment: Chrome `151.0.7922.170`, localhost COOP/COEP, production Worker, self-built BrowserJDK `21.0.10+7-LTS`, server baseline OpenJDK `21.0.10`.

| Case | Browser vs Server | Expected |
|---|---|---|
| `scanner_ab` | PASS | PASS |
| `scanner_until_eof` | PASS | PASS |
| `bufferedreader_ab` | PASS | PASS |
| `bufferedreader_until_eof` | PASS | PASS |
| `stringtokenizer` | PASS | PASS |
| `bufferedinputstream_fastscanner` | PASS | PASS |
| `system_in_read` | PASS | PASS |
| `empty_input` | PASS | PASS |
| `no_trailing_newline` | PASS | PASS |
| `large_input_10000` | PASS | PASS |
| `unicode` | PASS | PASS |
| `multi_case` | PASS | PASS |

Compatibility Match: `12/12`. Correctness Match: `12/12`. Raw machine-readable results are generated at `compat-tests/java21/results/checkpoint1-results.json` and intentionally git-ignored.
