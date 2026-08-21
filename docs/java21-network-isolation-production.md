# Java 21 Production Network Isolation

环境：真实 Problem Page + Chrome 151 + self-built `java21-browserjdk-compat-v2`。结论：PASS。

Local Java Run 捕获到的 source-like requests 为 0，non-GET 为 0。仅允许 runtime/static GET；Java source、stdin、local stdout 与 local stderr 均未上传。页面常规 heartbeat 被作为无敏感字段的已知 background request 单独分类，不与 Local Run 数据通道混淆。

Formal Submit 单独采样：捕获到恰好一个 submissions POST，body field 含 `code`，因此 source upload 仅发生在用户正式提交时。

报告只保留 request metadata、body field names、byte length 与 SHA-256，不持久化源码或 stdin 内容。

机器证据：`compat-tests/java21/network/java21-network-isolation.json`。
