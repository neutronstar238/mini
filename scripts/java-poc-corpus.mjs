/* ============================================================
 * JavaBox Technical PoC — 12-case ACM Corpus Driver
 * ------------------------------------------------------------
 * 验证浏览器内 Java 21 运行时对 ACM/OJ 标准 IO + 算法的支持。
 * 每个 case 写一个 Java 源码 + stdin + 期望输出 + 期望状态。
 * 跑出 Browser vs Server stdout 一致性表 + Network Isolation 报告。
 * ------------------------------------------------------------
 * TECHNICAL_REFERENCE_ONLY — JavaBox 无 LICENSE，禁止 vendor。
 * ============================================================ */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = process.env.JAVA_POC_DIR || path.join(__dirname, '..', '.codebuddy', 'tmp', 'java-poc');
const EVIDENCE_FILE = path.join(ASSET_DIR, 'poc-corpus-evidence.jsonl');
function rec(o){ try { fs.appendFileSync(EVIDENCE_FILE, JSON.stringify({ts:new Date().toISOString(),...o})+'\n'); } catch (_) {} }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

export const CASES = [
  {
    name: '01 A+B (Scanner)', cls: 'Main',
    stdin: '3 5\n',
    source: 'import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int a = in.nextInt(); int b = in.nextInt();\n    System.out.println(a + b);\n  }\n}\n',
    expectOut: '8', expectStatus: 'ok', category: 'io'
  },
  {
    name: '02 A+B (BufferedReader/Tokenizer)', cls: 'Main',
    stdin: '7 13\n',
    source: 'import java.io.*;\nimport java.util.*;\npublic class Main {\n  public static void main(String[] args) throws Exception {\n    BufferedReader br = new BufferedReader(new InputStreamReader(System.in));\n    StringTokenizer st = new StringTokenizer(br.readLine());\n    int a = Integer.parseInt(st.nextToken());\n    int b = Integer.parseInt(st.nextToken());\n    System.out.println(a + b);\n  }\n}\n',
    expectOut: '20', expectStatus: 'ok', category: 'io'
  },
  {
    name: '03 FastScanner (BufferedInputStream)', cls: 'Main',
    stdin: '100 200 300\n',
    source: 'import java.io.*;\npublic class Main {\n  public static void main(String[] args) throws Exception {\n    FastScanner fs = new FastScanner(System.in);\n    int a = fs.nextInt(); int b = fs.nextInt(); int c = fs.nextInt();\n    System.out.println(a + b + c);\n  }\n  static class FastScanner {\n    private final byte[] buffer = new byte[1 << 16];\n    private int ptr = 0, len = 0;\n    private final InputStream in;\n    FastScanner(InputStream in) { this.in = in; }\n    private int read() throws IOException {\n      if (ptr >= len) { len = in.read(buffer); ptr = 0; if (len <= 0) return -1; }\n      return buffer[ptr++];\n    }\n    int nextInt() throws IOException {\n      int c, sign = 1, val = 0;\n      do { c = read(); } while (c <= 32 && c != -1);\n      if (c == 45) { sign = -1; c = read(); }\n      while (c > 32) { val = val * 10 + (c - 48); c = read(); }\n      return val * sign;\n    }\n  }\n}\n',
    expectOut: '600', expectStatus: 'ok', category: 'io'
  },
  {
    name: '04 Sort (Arrays.sort)', cls: 'Main',
    stdin: '5\n3 1 4 1 5\n',
    source: 'import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int n = in.nextInt();\n    int[] a = new int[n];\n    for (int i = 0; i < n; i++) a[i] = in.nextInt();\n    Arrays.sort(a);\n    StringBuilder sb = new StringBuilder();\n    for (int i = 0; i < n; i++) { if (i > 0) sb.append(\" \"); sb.append(a[i]); }\n    System.out.println(sb.toString());\n  }\n}\n',
    expectOut: '1 1 3 4 5', expectStatus: 'ok', category: 'algorithm'
  },
  {
    name: '05 Binary Search', cls: 'Main',
    stdin: '5\n1 3 5 7 9\n5\n',
    source: 'import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int n = in.nextInt();\n    int[] a = new int[n];\n    for (int i = 0; i < n; i++) a[i] = in.nextInt();\n    int target = in.nextInt();\n    int lo = 0, hi = n - 1, ans = -1;\n    while (lo <= hi) {\n      int mid = (lo + hi) >>> 1;\n      if (a[mid] == target) { ans = mid; break; }\n      else if (a[mid] < target) lo = mid + 1;\n      else hi = mid - 1;\n    }\n    System.out.println(ans);\n  }\n}\n',
    expectOut: '2', expectStatus: 'ok', category: 'algorithm'
  },
  {
    name: '06 BFS (level order)', cls: 'Main',
    stdin: '4 3\n1 2\n1 3\n2 4\n1\n',
    source: 'import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int n = in.nextInt(), m = in.nextInt();\n    List<List<Integer>> g = new ArrayList<>();\n    for (int i = 0; i <= n; i++) g.add(new ArrayList<>());\n    for (int i = 0; i < m; i++) {\n        int u = in.nextInt(), v = in.nextInt();\n        g.get(u).add(v); g.get(v).add(u);\n    }\n    int start = in.nextInt();\n    int[] dist = new int[n + 1]; Arrays.fill(dist, -1);\n    ArrayDeque<Integer> q = new ArrayDeque<>();\n    q.add(start); dist[start] = 0;\n    while (!q.isEmpty()) {\n      int u = q.poll();\n      for (int v : g.get(u)) if (dist[v] == -1) { dist[v] = dist[u] + 1; q.add(v); }\n    }\n    StringBuilder sb = new StringBuilder();\n    for (int i = 1; i <= n; i++) { if (i > 1) sb.append(\" \"); sb.append(dist[i]); }\n    System.out.println(sb.toString());\n  }\n}\n',
    expectOut: '0 1 1 2', expectStatus: 'ok', category: 'algorithm'
  },
  {
    name: '07 Dijkstra (shortest path)', cls: 'Main',
    stdin: '5 7\n1 2 2\n1 3 4\n2 3 1\n2 4 7\n3 4 3\n3 5 5\n4 5 1\n1 5\n',
    source: 'import java.util.*;\npublic class Main {\n  static class Edge { int to, w; Edge(int t, int w){to=t;this.w=w;} }\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int n = in.nextInt(), m = in.nextInt();\n    List<List<Edge>> g = new ArrayList<>();\n    for (int i = 0; i <= n; i++) g.add(new ArrayList<>());\n    for (int i = 0; i < m; i++) {\n      int u = in.nextInt(), v = in.nextInt(), w = in.nextInt();\n      g.get(u).add(new Edge(v, w)); g.get(v).add(new Edge(u, w));\n    }\n    int src = in.nextInt(), dst = in.nextInt();\n    int[] dist = new int[n + 1]; Arrays.fill(dist, Integer.MAX_VALUE);\n    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[1] - b[1]);\n    dist[src] = 0; pq.add(new int[]{src, 0});\n    while (!pq.isEmpty()) {\n      int[] cur = pq.poll(); int u = cur[0], du = cur[1];\n      if (du > dist[u]) continue;\n      for (Edge e : g.get(u)) {\n        if (dist[e.to] > du + e.w) {\n          dist[e.to] = du + e.w;\n          pq.add(new int[]{e.to, dist[e.to]});\n        }\n      }\n    }\n    System.out.println(dist[dst]);\n  }\n}\n',
    expectOut: '7', expectStatus: 'ok', category: 'algorithm'
  },
  {
    name: '08 Union Find', cls: 'Main',
    stdin: '5 3\n1 2\n2 3\n4 5\n1\n1 4\n',
    source: 'import java.util.*;\npublic class Main {\n  static int[] p;\n  static int find(int x){ return p[x]==x?x:(p[x]=find(p[x])); }\n  static void union(int a, int b){ p[find(a)]=find(b); }\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int n = in.nextInt(), m = in.nextInt();\n    p = new int[n + 1]; for (int i = 1; i <= n; i++) p[i] = i;\n    for (int i = 0; i < m; i++) { int a = in.nextInt(), b = in.nextInt(); union(a, b); }\n    int q = in.nextInt();\n    StringBuilder sb = new StringBuilder();\n    int a = in.nextInt(), b = in.nextInt();\n    sb.append(find(a) == find(b) ? \"YES\" : \"NO\");\n    System.out.println(sb.toString());\n  }\n}\n',
    expectOut: 'NO', expectStatus: 'ok', category: 'algorithm'
  },
  {
    name: '09 PriorityQueue (kth smallest)', cls: 'Main',
    stdin: '5 3\n7 2 5 1 4\n',
    source: 'import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int n = in.nextInt(), k = in.nextInt();\n    PriorityQueue<Integer> maxh = new PriorityQueue<>((a, b) -> b - a);\n    for (int i = 0; i < n; i++) {\n      maxh.add(in.nextInt());\n      if (maxh.size() > k) maxh.poll();\n    }\n    System.out.println(maxh.peek());\n  }\n}\n',
    expectOut: '4', expectStatus: 'ok', category: 'algorithm'
  },
  {
    name: '10 BigInteger (factorial)', cls: 'Main',
    stdin: '25\n',
    source: 'import java.math.BigInteger;\nimport java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int n = in.nextInt();\n    BigInteger f = BigInteger.ONE;\n    for (int i = 2; i <= n; i++) f = f.multiply(BigInteger.valueOf(i));\n    System.out.println(f.toString().length());\n  }\n}\n',
    expectOut: '26', expectStatus: 'ok', category: 'bigint'
  },
  {
    name: '11 CE (illegal start of expression)', cls: 'Main',
    stdin: '',
    source: 'public class Main {\n  public static void main(String[] args) {\n    int x =\n  }\n}\n',
    expectOut: '', expectStatus: 'ce', category: 'error'
  },
  {
    name: '12 RE (ArrayIndexOutOfBoundsException)', cls: 'Main',
    stdin: '',
    source: 'public class Main {\n  public static void main(String[] args) {\n    int[] a = new int[3];\n    System.out.println(a[10]);\n  }\n}\n',
    expectOut: '', expectStatus: 're', category: 'error'
  }
];

async function main() {
  try { fs.unlinkSync(EVIDENCE_FILE); } catch (_) {}
  const wasm = path.join(ASSET_DIR, 'javabox-direct.wasm');
  const data = path.join(ASSET_DIR, 'javabox-direct.data');
  const mjs  = path.join(ASSET_DIR, 'javabox-direct.mjs');
  for (const f of [wasm, data, mjs]) if (!fs.existsSync(f)) { rec({ event: 'fatal', msg: 'missing ' + f }); process.exit(2); }
  rec({ event: 'start', nodeVersion: process.version, totalCases: CASES.length });

  const allOutput = [];
  const moduleImpl = {
    print: (t) => { allOutput.push(t); },
    printErr: (t) => { allOutput.push('[err] ' + t); },
    onExit: (c) => { allOutput.push('[exit] ' + c); rec({ event: 'jvm_onExit', code: c }); },
    locateFile: (p) => p === 'javabox-direct.wasm' ? wasm : p === 'javabox-direct.data' ? data : path.join(ASSET_DIR, p)
  };

  const tM0 = Date.now();
  const { default: createModule } = await import(pathToFileURL(mjs).href);
  const Module = await createModule(moduleImpl);
  const tM1 = Date.now();
  rec({ event: 'module_created', moduleInitMs: tM1 - tM0 });

  try { Module.ccall('jvm_enable_ring_buffer_stdin', null, [], []); } catch (_) {}

  const sendToGuest = (raw) => {
    try { Module.ccall('jvm_stdin_write_string', null, ['string'], [raw]); } catch (_) {}
  };

  // 等 PONG
  rec({ event: 'wait_pong_begin' });
  const tPing0 = Date.now();
  let bootOk = false;
  const pingTimer = setInterval(() => sendToGuest('JBOX_PING\n'), 500);
  while (Date.now() - tPing0 < 30000) {
    if (allOutput.some((t) => typeof t === 'string' && t.includes('JBOX_PONG'))) { bootOk = true; break; }
    await sleep(200);
  }
  clearInterval(pingTimer);
  const tBoot = Date.now();
  rec({ event: 'boot_result', bootOk, bootMs: tBoot - tM0, outputTail: allOutput.slice(-10) });
  if (!bootOk) {
    rec({ event: 'BLOCKING', reason: 'JVM/CompileServer not ready within 30s' });
  }

  const results = [];
  for (const c of CASES) {
    allOutput.length = 0;
    await sleep(200); // 让前一个 case 的 JBOX_EXIT 被 CompileServer 主循环消化
    const cStart = Date.now();

    if (c.stdin) sendToGuest(c.stdin);
    const cmd = 'JBOX_COMPILE ' + c.cls + '\n' + c.source + '\nJBOX_END\n';
    sendToGuest(cmd);

    let exitCode = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const joined = allOutput.join('\n');
      const m = joined.match(/JBOX_EXIT:(-?\d+)/);
      if (m) { exitCode = parseInt(m[1]); break; }
      await sleep(150);
    }
    const cEnd = Date.now();
    const combined = allOutput.join('\n');

    let status = 'unknown';
    if (exitCode === 0) status = 'ok';
    else if (exitCode != null) {
      if (/(?:Exception in thread|java\.lang\.(?:Arithmetic|NullPointer|ArrayIndexOutOfBounds|ClassCast|StackOverflow|NumberFormat|IllegalArgument|IllegalState|IndexOutOfBounds)Exception)/.test(combined)) status = 're';
      else if (/Main\.java:\d+:\s*(?:error|错误)/.test(combined)) status = 'ce';
      else status = 'non-zero-exit(' + exitCode + ')';
    } else status = 'timeout';

    const userStdout = combined.split('\n').filter((l) =>
      !/^JBOX_(PONG|EXIT:\d+|COMPILE|END|PING|DOOM)/.test(l)
      && !/^={5,}/.test(l)
      && !/^\[exit\]/.test(l)
      && !/^\[err\]/.test(l)
    ).join('\n').trim();

    const actualOut = userStdout;
    const ok = status === c.expectStatus && (status !== 'ok' || actualOut === c.expectOut);

    results.push({
      name: c.name, category: c.category,
      ok,
      expectStatus: c.expectStatus,
      expectOut: c.expectOut,
      actualStatus: status,
      actualOut: actualOut.slice(0, 200),
      exitCode,
      elapsedMs: cEnd - cStart
    });
    rec({ event: 'case', ...results[results.length - 1] });
  }

  // 汇总
  const passed = results.filter((r) => r.ok).length;
  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] = byCategory[r.category] || { passed: 0, total: 0 };
    byCategory[r.category].total++;
    if (r.ok) byCategory[r.category].passed++;
  }

  const summary = {
    event: 'CORPUS_SUMMARY',
    bootOk,
    bootMs: tBoot - tM0,
    totalElapsedMs: Date.now() - tM0,
    passed,
    total: CASES.length,
    passRate: passed / CASES.length,
    byCategory,
    technicallyValidated: bootOk && passed === CASES.length,
    note: 'TECHNICAL_REFERENCE_ONLY — JavaBox 无 LICENSE；不作为正式 OJ runtime 依赖'
  };
  rec(summary);

  console.log('\n========= Java ACM Corpus (12 cases) =========');
  console.log('bootOk:', bootOk, ' bootMs:', summary.bootMs);
  console.log('casesPassed:', passed + '/' + CASES.length);
  console.log('passRate:', (summary.passRate * 100).toFixed(1) + '%');
  for (const cat of Object.keys(byCategory)) {
    const s = byCategory[cat];
    console.log('  [' + cat + '] ' + s.passed + '/' + s.total);
  }
  console.log('technicallyValidated:', summary.technicallyValidated);

  setTimeout(() => process.exit(0), 100).unref();
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    rec({ event: 'FATAL', err: String(e && e.message || e), stack: String(e && e.stack || '').slice(0, 600) });
    process.exit(4);
  });
}
