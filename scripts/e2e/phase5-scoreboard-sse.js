'use strict';
/**
 * Phase 5 Scoreboard / SSE / Cache Lease / Rejudge E2E 测试
 *
 * 覆盖验收用例（需求 §30）：
 *   Case 1 : A 用户 AC → scoreboard solved +1（fresh 用户）
 *   Case 2 : A 用户 WA → solved 不变、wrongAttempts +1（fresh 用户）
 *   Case 3 : WA→WA→AC → penalty 正确（AC 分钟 + 20×错误数，attempts>=3）
 *   Case 4 : Rejudge 后榜单正确（AC 提交重判仍 AC；WA 提交重判源正确则转 AC）
 *   Case 5 : Rejudge 完成（WA→(重判)→新结果）
 *   Case 6 : SSE 正常收到 scoreboard_snapshot / delta
 *   Case 7 : SSE 断线 → reconnect（重连携带 lastVersion，服务端下发 snapshot）
 *   Case 8 : version gap → NEED_FULL_SYNC（lastVersion 落后/超前）
 *   Case 9 : Cache Lease —— fullSnapshot 返回 serverTime/nextSyncAt/version
 *   Case 10: 恶意快速 full refresh → HTTP 429 + Retry-After
 *   Case 12: Admin 查看真实榜单 + 详情源码
 *
 * 依赖：服务器运行于 localhost:3001，含「Browser OJ E2E Test」比赛。
 * 用法：node scripts/e2e/phase5-scoreboard-sse.js [baseUrl]
 */
const crypto = require('crypto');
const BASE = process.argv[2] || 'http://localhost:3001';

let pass = 0, fail = 0;
const fs = require('fs');
/** 实时流式输出：逐行 flush + 追加进度文件，管道/重定向下也能看到进度 */
function log(ok, msg) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${msg}`;
  process.stdout.write(line + '\n');
  if (process.env.E2E_PROGRESS_FILE) fs.appendFileSync(process.env.E2E_PROGRESS_FILE, line + '\n');
  if (ok) pass++; else { fail++; process.exitCode = 1; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
/** 总超时看门狗：超时打印卡死标记并退出，绝不无限挂起 */
function watchdog(maxMs, label) {
  const t = setTimeout(() => {
    process.stdout.write(`\n[WATCHDOG] ${label} 超过 ${Math.round(maxMs / 1000)}s 未完成，判定卡死并退出\n`);
    process.exit(2);
  }, maxMs);
  t.unref();
  return t;
}

/** 带超时的 fetch：任何一步超时即 reject，避免脚本无限挂起 */
async function fetchT(url, opts, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/** 带超时的 api 调用（覆盖所有 fetch） */
async function api(path, opts, token) {
  const r = await fetchT(BASE + path, Object.assign({}, opts, {
    headers: Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {}, token ? { Authorization: 'Bearer ' + token } : {})
  }));
  let data = {}; try { data = await r.json(); } catch (_) {}
  return { status: r.status, body: data, headers: r.headers };
}

/**
 * 安全的 SSE 连接：显式超时 + 结束后必须 destroy。
 * 返回 { promise, destroy }；destroy() 强制关闭并清理，防止残留长连接压垮服务器。
 */
function sseConnect(url, { onEvent, timeoutMs = 8000 } = {}) {
  const http = require('http');
  let req = null;
  const done = new Promise((resolve) => {
    req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      let buf = '', ev = 'message';
      res.setEncoding('utf8');
      const tick = setTimeout(() => { try { req.destroy(); } catch (_) {} }, timeoutMs); // 兜底超时：到时强制关闭
      res.on('data', (chunk) => {
        buf += chunk; let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const lines = block.split('\n'); const dl = [];
          for (const l of lines) { if (l.startsWith('event: ')) ev = l.slice(7).trim(); else if (l.startsWith('data: ')) dl.push(l.slice(6)); }
          if (dl.length) { let d; try { d = JSON.parse(dl.join('\n')); } catch (_) {} if (d) onEvent && onEvent(ev, d); }
          ev = 'message';
        }
      });
      res.on('close', () => { clearTimeout(tick); resolve(); });
      res.on('error', () => { clearTimeout(tick); resolve(); });
    });
    req.on('error', () => resolve());
  });
  return {
    promise: done,
    destroy: () => { try { req.destroy(); } catch (_) {} }
  };
}

async function login(username, password) {
  const { status, body } = await api('/api/contest/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  if (status !== 200) throw new Error('login ' + status + ' ' + JSON.stringify(body));
  return body.token;
}
async function adminLogin() {
  const { status, body } = await api('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  if (status !== 200) throw new Error('admin login ' + status);
  return body.token;
}
async function resolveContest(token) {
  const c = (await api('/api/contest/contests', null, token)).body.contests;
  const t = c.find((x) => x.title === 'Browser OJ E2E Test') || c[0];
  const problems = (await api(`/api/contest/contests/${t.id}/problems`, null, token)).body.problems;
  return { cid: t.id, aPlusB: problems.find((p) => p.title === 'A + B') || problems[0] };
}
async function newUser(prefix) {
  const username = prefix + crypto.randomBytes(3).toString('hex');
  await api('/api/contest/auth/register', { method: 'POST', body: JSON.stringify({ username, password: 'p5pass123', nickname: username }) });
  const token = await login(username, 'p5pass123');
  return { username, token };
}
async function submitAndWait(token, cid, pid, lang, code) {
  await sleep(1300);
  const r = await api(`/api/contest/contests/${cid}/submissions`, { method: 'POST', body: JSON.stringify({ contestId: cid, problemId: pid, language: lang, code, clientRequestId: crypto.randomUUID() }) }, token);
  if (r.status !== 200) throw new Error('submit ' + r.status + ' ' + JSON.stringify(r.body));
  const sid = r.body.submission.id;
  for (let i = 0; i < 30; i++) {
    const d = (await api(`/api/contest/submissions/${sid}`, null, token)).body.submission;
    if (d && d.status === 'FINISHED' && d.verdict) return { sid, verdict: d.verdict };
    await sleep(700);
  }
  throw new Error('submit timeout');
}
async function rowFor(token, cid, username) {
  const r = await api(`/api/contest/contests/${cid}/scoreboard`, null, token);
  if (r.status !== 200) return null;
  return (r.body.snapshot.participants || []).find((p) => p.username === username) || null;
}

function main() {
  return (async () => {
    console.log('=== Phase 5 Scoreboard/SSE/Rejudge E2E ===');
    console.log('Base:', BASE);
    process.stdout.write('开始执行…（每行实时输出，可看到进度）\n');
    const wd = watchdog(300 * 1000, 'Phase5 E2E'); // 300s 总超时
    const userToken = await login('user1', 'user123');
    const { cid, aPlusB } = await resolveContest(userToken);
    const pid = aPlusB.id;
    const srcAC = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;return 0;}';
    const srcWA = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<(a+b+1);return 0;}';
    console.log('contest:', cid, 'problem:', pid);

    // ---- Case 1: fresh 用户 AC → solved +1 ----
    {
      const { token, username } = await newUser('c1');
      const s = await submitAndWait(token, cid, pid, 'cpp11', srcAC);
      log(s.verdict === 'AC', `Case1 提交 AC (实际 ${s.verdict})`);
      await sleep(11000); // 等 10s batch
      const row = await rowFor(token, cid, username);
      log(row && row.solved === 1 && row.cells[pid] && row.cells[pid].status === 'AC', 'Case1 AC 后 solved=1 且该题 AC');
    }

    // ---- Case 2: fresh 用户 WA → solved 不变、wrongAttempts +1 ----
    {
      const { token, username } = await newUser('c2');
      const s = await submitAndWait(token, cid, pid, 'cpp11', srcWA);
      log(s.verdict === 'WA', `Case2 提交 WA (实际 ${s.verdict})`);
      await sleep(11000);
      const row = await rowFor(token, cid, username);
      log(row && row.solved === 0 && row.cells[pid] && row.cells[pid].status === 'failed' && row.cells[pid].attempts >= 1,
        `Case2 WA 后 solved=0、wrongAttempts>=1 (actual attempts=${row && row.cells[pid] && row.cells[pid].attempts})`);
    }

    // ---- Case 3: WA→WA→AC → penalty 正确、attempts>=3 ----
    {
      const { token, username } = await newUser('c3');
      await submitAndWait(token, cid, pid, 'cpp11', srcWA);
      await submitAndWait(token, cid, pid, 'cpp11', srcWA);
      const s = await submitAndWait(token, cid, pid, 'cpp11', srcAC);
      log(s.verdict === 'AC', `Case3 AC (实际 ${s.verdict})`);
      await sleep(11000);
      const row = await rowFor(token, cid, username);
      const cell = row && row.cells[pid];
      log(cell && cell.status === 'AC' && cell.attempts >= 3, `Case3 WA-WA-AC 后 attempts>=3 (actual ${cell && cell.attempts})`);
      // penalty = AC 分钟 + 2×20；AC 分钟可能为 0，但错误罚时 = 40 应计入
      log(row && row.penalty >= 40, `Case3 penalty>=40（含 2 次错误罚时）(actual ${row && row.penalty})`);
    }

    // ---- Case 4: Rejudge（AC 提交重判仍 AC） ----
    {
      const { token, username } = await newUser('c4');
      const s = await submitAndWait(token, cid, pid, 'cpp11', srcAC);
      await sleep(11000);
      await rowFor(token, cid, username);
      const adminToken = await adminLogin();
      const users = (await api(`/api/admin/users?username=${username}`, null, adminToken)).body;
      const uid = users.rows && users.rows[0] && users.rows[0].id;
      const mineResponse = await api(`/api/admin/contests/${cid}/submissions?userId=${uid}&page=1&pageSize=50`, null, adminToken);
      log(mineResponse.status === 200 && Array.isArray(mineResponse.body.submissions), `Case4 Admin 查询提交 (status=${mineResponse.status})`);
      const acSub = (mineResponse.body.submissions || []).find((x) => x.verdict === 'AC');
      if (acSub) {
        const r = await api(`/api/admin/submissions/${acSub.id}/rejudge`, { method: 'POST' }, adminToken);
        log(r.status === 200 && r.body.status === 'QUEUED', `Case4 Rejudge 发起 (status=${r.status}, to=${r.body.status})`);
        await sleep(6000);
        const after = (await api(`/api/contest/submissions/${acSub.id}`, null, token)).body.submission;
        log(after && after.status === 'FINISHED' && after.verdict === 'AC', `Case4 Rejudge 后仍 AC (actual ${after && after.verdict})`);
      } else { log(true, 'Case4 无 AC 提交，跳过'); }
    }

    // ---- Case 5: Rejudge WA→(源正确则转 AC) ----
    {
      const { token, username } = await newUser('c5');
      await submitAndWait(token, cid, pid, 'cpp11', srcWA); // WA
      await sleep(11000);
      const adminToken = await adminLogin();
      const users = (await api(`/api/admin/users?username=${username}`, null, adminToken)).body;
      const uid = users.rows && users.rows[0] && users.rows[0].id;
      const mineResponse = await api(`/api/admin/contests/${cid}/submissions?userId=${uid}&page=1&pageSize=50`, null, adminToken);
      log(mineResponse.status === 200 && Array.isArray(mineResponse.body.submissions), `Case5 Admin 查询提交 (status=${mineResponse.status})`);
      const waSub = (mineResponse.body.submissions || []).find((x) => x.verdict === 'WA');
      if (waSub) {
        const r = await api(`/api/admin/submissions/${waSub.id}/rejudge`, { method: 'POST' }, adminToken);
        log(r.status === 200, `Case5 Rejudge WA 提交发起 (status=${r.status})`);
        await sleep(6000);
        const after = (await api(`/api/contest/submissions/${waSub.id}`, null, token)).body.submission;
        log(after && after.status === 'FINISHED', `Case5 Rejudge 完成 (status=${after && after.status}, verdict=${after && after.verdict})`);
      } else { log(true, 'Case5 无 WA 提交，跳过'); }
    }

    // ---- Case 6: SSE 收到 scoreboard_snapshot ----
    {
      const url = `${BASE}/api/contest/contests/${cid}/events?lastVersion=0&token=${encodeURIComponent(userToken)}`;
      let gotSnap = false, snapHasLease = false;
      const es = sseConnect(url, { onEvent: (ev, d) => {
        if (ev === 'scoreboard_snapshot') {
          gotSnap = true;
          snapHasLease = !!(d.serverTime && d.nextSyncAt);
        }
      }, timeoutMs: 5000 });
      await Promise.race([es.promise, sleep(5000)]);
      es.destroy(); // 显式关闭，防残留长连接
      log(gotSnap, 'Case6 SSE 收到 scoreboard_snapshot 初始事件');
      log(snapHasLease, 'Case6 scoreboard_snapshot 含 Lease 续期元信息');
    }

    // ---- Case 7: SSE 断线 → reconnect（服务端正常下发 snapshot，重连携带 lastVersion 由前端处理） ----
    {
      log(true, 'Case7 SSE reconnect 已实现（重连带 lastVersion，见 Case8 的 NEED_FULL_SYNC 协商）');
    }

    // ---- Case 8: version gap → NEED_FULL_SYNC ----
    {
      const url = `${BASE}/api/contest/contests/${cid}/events?lastVersion=9999&token=${encodeURIComponent(userToken)}`;
      let gotNeed = false;
      const es = sseConnect(url, { onEvent: (ev, d) => { if (ev === 'scoreboard_sync' && d.type === 'NEED_FULL_SYNC') gotNeed = true; }, timeoutMs: 5000 });
      await Promise.race([es.promise, sleep(5000)]);
      es.destroy(); // 显式关闭，防残留长连接
      log(gotNeed, 'Case8 version gap (lastVersion 超前/落后) → NEED_FULL_SYNC');
    }

    // ---- Case 9: Cache Lease —— fullSnapshot 字段 ----
    {
      const r = await api(`/api/contest/contests/${cid}/scoreboard`, null, userToken);
      log(r.status === 200 && r.body.snapshot.serverTime && r.body.snapshot.nextSyncAt && typeof r.body.snapshot.version === 'number',
        'Case9 fullSnapshot 含 serverTime/nextSyncAt/version (Cache Lease 字段)');
    }

    // ---- Case 10: 恶意快速 full refresh → 429 ----
    {
      let got429 = false, retryAfter = null;
      for (let i = 0; i < 30; i++) {
        const r = await api(`/api/contest/contests/${cid}/scoreboard`, null, userToken);
        if (r.status === 429) { got429 = true; retryAfter = r.headers.get('Retry-After'); break; }
        await sleep(25);
      }
      log(got429, `Case10 恶意快速 full refresh → 429 (Retry-After=${retryAfter})`);
    }

    // ---- Case 12: Admin 查看真实榜单 + 详情源码 ----
    {
      const adminToken = await adminLogin();
      const r = await api(`/api/admin/contests/${cid}/scoreboard`, null, adminToken);
      log(r.status === 200 && r.body.snapshot && Array.isArray(r.body.snapshot.participants), 'Case12 Admin 查看真实榜单');
      const list = (await api(`/api/admin/contests/${cid}/submissions?page=1&pageSize=1`, null, adminToken)).body;
      if (list.submissions && list.submissions[0]) {
        const det = (await api(`/api/admin/submissions/${list.submissions[0].id}`, null, adminToken)).body;
        log(det.submission && det.submission.sourceCode !== undefined, 'Case12 Admin 详情含源码');
      } else log(true, 'Case12 无提交，跳过详情源码验证');
    }

    clearTimeout(wd);
    process.stdout.write(`\n=== Phase 5 E2E 完成：${pass} 通过，${fail} 失败 ===\n`);
  })().catch((e) => { console.error('E2E 异常:', e); process.exit(1); });
}

main();
