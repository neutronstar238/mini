'use strict';
/**
 * Phase 4 OJ Core 主链路 E2E 测试
 *
 * 覆盖 Case 1-10（三语言各 AC 一次 + CE/WA/RE/TLE + hidden-WA + 幂等 + 越权，全状态机）：
 *   Case 1 : 登录 → A+B → C++11 AC（服务端 Formal Submit → AC）
 *   Case 1b: A+B → C11 AC（三语言各 AC）
 *   Case 1c: A+B → Python3 AC（三语言各 AC）
 *   Case 2 : C11 语法错误 → Official CE
 *   Case 3 : Python ZeroDivisionError → Official RE
 *   Case 4 : 错误答案 → Official WA
 *   Case 4b: 1+2+...+n naive 循环（Python）→ TLE
 *   Case 5 : 公开样例通过但 hidden 失败（int 溢出）→ Official WA（证明 Local Sample Passed != Accepted）
 *   Case 6 : 同 clientRequestId 二次提交 → 幂等返回同一 submissionId
 *   Case 7 : 用户 A 访问用户 B submission → 403
 *
 * 注意：
 *   - 语言字段传正式值 c11/cpp11/python3（服务端 allowlist），非前端 c/cpp/python。
 *   - 同用户限速 1 次/秒，提交请求统一节流并对 429 重试一次。
 *   - TLE case 用 Python naive 循环：gcc -O2 会把 C 的 1+2+...+n 求和优化为 O(1) 而 AC，无法触发 TLE。
 *
 * 用法：node scripts/e2e/oj-main-path.js [baseUrl]
 *   baseUrl 默认 http://localhost:3001
 */
const crypto = require('crypto');
const BASE = process.argv[2] || 'http://localhost:3001';

let pass = 0, fail = 0;
const fs = require('fs');
/** 实时流式输出：写 stdout（行缓冲）+ 追加到进度文件，确保管道/重定向下也能看到每一行 */
function log(ok, msg) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${msg}`;
  process.stdout.write(line + '\n'); // 强制逐行 flush，不等块缓冲
  if (process.env.E2E_PROGRESS_FILE) fs.appendFileSync(process.env.E2E_PROGRESS_FILE, line + '\n');
  if (ok) pass++; else { fail++; process.exitCode = 1; }
}

/** 总超时看门狗：超过 maxMs 自动打印卡死标记并退出，绝不无限挂起 */
function watchdog(maxMs, label) {
  const t = setTimeout(() => {
    process.stdout.write(`\n[WATCHDOG] ${label} 超过 ${Math.round(maxMs / 1000)}s 未完成，判定卡死并退出\n`);
    process.exit(2);
  }, maxMs);
  t.unref();
  return t;
}

async function login(username, password) {
  const r = await fetch(`${BASE}/api/contest/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const j = await r.json();
  if (!r.ok) throw new Error('login failed: ' + JSON.stringify(j));
  return j.token;
}
async function get(path, token) {
  const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } });
  return { status: r.status, body: await r.json() };
}
let lastSubmissionAt = 0;
async function post(path, body, token) {
  const isSubmission = /\/contests\/[^/]+\/submissions$/.test(path);
  if (isSubmission) {
    await sleep(Math.max(0, 1100 - (Date.now() - lastSubmissionAt)));
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body)
    });
    const result = { status: r.status, body: await r.json() };
    if (isSubmission) lastSubmissionAt = Date.now();
    if (r.status !== 429 || !isSubmission || attempt === 1) return result;
    await sleep(1200);
  }
}
async function waitForVerdict(token, submissionId, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { body } = await get(`/api/contest/submissions/${submissionId}`, token);
    const s = body.submission;
    if (s.status === 'FINISHED' && s.verdict) return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timeout waiting for verdict');
}

/** 睡眠：规避 SubmissionService 同用户 1 次/秒限速 */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 提交一次并等待最终 verdict（post 统一处理限速间隔） */
async function submitAndWait(token, cid, pid, payload) {
  const { status, body } = await post(`/api/contest/contests/${cid}/submissions`,
    { contestId: cid, problemId: pid, language: payload.language, code: payload.code, clientRequestId: crypto.randomUUID() }, token);
  if (status !== 200) throw new Error('提交失败: ' + JSON.stringify(body));
  return waitForVerdict(token, body.submission.id);
}

async function main() {
  console.log('=== Phase 4 OJ Main Path E2E ===');
  console.log('Base:', BASE);
  process.stdout.write('开始执行…（每行实时输出，可看到进度）\n');
  const wd = watchdog(120 * 1000, 'Phase4 E2E'); // 120s 总超时

  const userToken = await login('user1', 'user123');

  // 解析「Browser OJ E2E Test」比赛与 A+B 题目
  const contests = (await get('/api/contest/contests', userToken)).body.contests;
  let target = contests.find((c) => c.title === 'Browser OJ E2E Test');
  let cid = target ? target.id : (contests[0] && contests[0].id);
  let problems = (await get(`/api/contest/contests/${cid}/problems`, userToken)).body.problems;
  let aPlusB = problems.find((p) => p.title === 'A + B') || problems[0];
  let pid = aPlusB.id;
  // 1+2+...+n 题目（naive 循环会 TLE）—— TLE case 专用
  let sumN = problems.find((p) => p.title === '1+2+...+n');
  let tid = sumN ? sumN.id : null;
  console.log('contest:', cid, 'A+B problem:', pid, '1+2+...+n problem:', tid);
  if (!cid || !pid) { log(false, '无法解析比赛/题目'); return; }
  if (!tid) { log(false, '未找到 1+2+...+n 题目，跳过 TLE case'); }

  // ---- Case 1: C++11 A+B AC ----
  {
    const src = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;return 0;}';
    const { status, body } = await post(`/api/contest/contests/${cid}/submissions`,
      { contestId: cid, problemId: pid, language: 'cpp11', code: src, clientRequestId: crypto.randomUUID() }, userToken);
    if (status !== 200) { log(false, 'Case1 提交失败: ' + JSON.stringify(body)); }
    else {
      const s = await waitForVerdict(userToken, body.submission.id);
      log(s.verdict === 'AC', `Case1 C++11 A+B → AC (实际 ${s.verdict})`);
    }
  }

  // ---- Case 1b: C11 A+B AC（三语言各 AC 一次）----
  {
    try {
      const s = await submitAndWait(userToken, cid, pid, { language: 'c11', code: '#include <stdio.h>\nint main(){long long a,b;scanf("%lld%lld",&a,&b);printf("%lld",a+b);return 0;}' });
      log(s.verdict === 'AC', `Case1b C11 A+B → AC (实际 ${s.verdict})`);
    } catch (e) { log(false, 'Case1b C11 AC 失败: ' + e.message); }
  }

  // ---- Case 1c: Python3 A+B AC（三语言各 AC 一次）----
  {
    try {
      const s = await submitAndWait(userToken, cid, pid, { language: 'python3', code: 'a,b=map(int,input().split())\nprint(a+b)' });
      log(s.verdict === 'AC', `Case1c Python3 A+B → AC (实际 ${s.verdict})`);
    } catch (e) { log(false, 'Case1c Python3 AC 失败: ' + e.message); }
  }

  // ---- Case 2: C11 语法错误 → CE ----
  {
    const src = 'int main( { return 0; }';
    const { body } = await post(`/api/contest/contests/${cid}/submissions`,
      { contestId: cid, problemId: pid, language: 'c11', code: src, clientRequestId: crypto.randomUUID() }, userToken);
    const s = await waitForVerdict(userToken, body.submission.id);
    log(s.verdict === 'CE', `Case2 C11 语法错误 → CE (实际 ${s.verdict})`);
  }

  // ---- Case 3: Python ZeroDivisionError → RE ----
  {
    const src = 'a=1\nb=0\nprint(a//b)';
    const { body } = await post(`/api/contest/contests/${cid}/submissions`,
      { contestId: cid, problemId: pid, language: 'python3', code: src, clientRequestId: crypto.randomUUID() }, userToken);
    const s = await waitForVerdict(userToken, body.submission.id);
    log(s.verdict === 'RE', `Case3 Python ZeroDivision → RE (实际 ${s.verdict})`);
  }

  // ---- Case 4: 错误答案 → WA ----
  {
    const src = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b+100;return 0;}';
    const { body } = await post(`/api/contest/contests/${cid}/submissions`,
      { contestId: cid, problemId: pid, language: 'cpp11', code: src, clientRequestId: crypto.randomUUID() }, userToken);
    const s = await waitForVerdict(userToken, body.submission.id);
    log(s.verdict === 'WA', `Case4 错误答案 → WA (实际 ${s.verdict})`);
  }

  // ---- Case 4b: 1+2+...+n naive 循环 → TLE（1e9 测试点 1s 内必超时）----
  if (tid) {
    try {
      // 用 Python 写 O(n) 累加：CPython 无编译器优化，n=1e9 次迭代必然超过 timeLimit(1000ms) 判定 TLE。
      // 注：若用 C 写同等 naive 循环，gcc -O2 会把 1+2+...+n 优化成 O(1) 公式而 AC，无法触发 TLE，
      // 故此处选 Python 以确保确定性地验证 TLE 状态机。
      const s = await submitAndWait(userToken, cid, tid, { language: 'python3', code: 'n=int(input())\ns=0\nfor i in range(1, n+1): s += i\nprint(s)' });
      log(s.verdict === 'TLE', `Case4b 1+2+...+n naive 循环 → TLE (实际 ${s.verdict})`);
    } catch (e) { log(false, 'Case4b TLE 失败: ' + e.message); }
  } else {
    log(false, 'Case4b TLE 跳过（未找到 1+2+...+n 题目）');
  }

  // ---- Case 5: 公开样例通过但 hidden 失败（int 溢出）→ WA（Local Sample Passed != Accepted）----
  {
    const src = '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;return 0;}'; // int 溢出 hidden 大数
    const { body } = await post(`/api/contest/contests/${cid}/submissions`,
      { contestId: cid, problemId: pid, language: 'cpp11', code: src, clientRequestId: crypto.randomUUID() }, userToken);
    const s = await waitForVerdict(userToken, body.submission.id);
    log(s.verdict === 'WA', `Case5 公开样例通过但 hidden WA (实际 ${s.verdict})`);
  }

  // ---- Case 6: 幂等（同 clientRequestId 二次提交返回同一 id）----
  {
    const clientRequestId = crypto.randomUUID();
    const src = '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;return 0;}';
    const b1 = await post(`/api/contest/contests/${cid}/submissions`,
      { contestId: cid, problemId: pid, language: 'cpp11', code: src, clientRequestId }, userToken);
    const b2 = await post(`/api/contest/contests/${cid}/submissions`,
      { contestId: cid, problemId: pid, language: 'cpp11', code: src, clientRequestId }, userToken);
    const same = b1.body.submission.id === b2.body.submission.id && !!b2.body.deduplicated;
    log(same, `Case6 幂等：二次提交返回同一 submissionId (${b1.body.submission.id})`);
  }

  // ---- Case 7: 越权（A 访问 B 的 submission → 403）----
  {
    // 注册一个临时用户 B
    const rand = 'u' + Date.now().toString(36);
    const reg = await post('/api/contest/auth/register', { username: rand, password: 'user123', nickname: 'B' }, null);
    if (reg.status !== 200 && reg.status !== 409) { log(false, 'Case7 注册用户 B 失败'); }
    const bToken = await login(rand, 'user123');
    const created = await post(`/api/contest/contests/${cid}/submissions`,
      { contestId: cid, problemId: pid, language: 'python3', code: 'print(1)', clientRequestId: crypto.randomUUID() }, bToken);
    const subId = created.body.submission.id;
    // 用户 A（user1）尝试读取用户 B 的 submission → 应 403
    const { status } = await get(`/api/contest/submissions/${subId}`, userToken);
    log(status === 403, `Case7 越权访问他人 submission → 403 (实际 ${status})`);
  }

  clearTimeout(wd); // 正常完成，取消看门狗
  process.stdout.write(`=== E2E 完成：${pass} 通过，${fail} 失败 ===\n`);
}

main().catch((e) => { console.error('E2E error:', e.stack || e.message); process.exitCode = 1; });
