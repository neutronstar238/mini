'use strict';
/**
 * 消融探针：最小化、每一步独立、5s 超时，用于定位服务器卡死。
 * 用法：node ablate-server.js <step>
 *   step=login    仅登录
 *   step=contests 登录+列比赛
 *   step=scoreboard 登录+读榜单
 *   step=submit   登录+提交 1 次并等 FINISHED（触发评测 + SSE 广播）
 *   step=probe    纯 HTTP 探活
 * 任何一步超时(8s) 即报 ABORT，不会无限挂起。
 */
const BASE = 'http://localhost:3001';
const step = process.argv[2] || 'probe';

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('ABORT ' + label + ' (' + ms + 'ms)')), ms))
  ]);
}
const sleep = (m) => new Promise((r) => setTimeout(r, m));

async function api(path, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(BASE + path, Object.assign({}, opts, { signal: ctrl.signal }));
    let d = {}; try { d = await r.json(); } catch (_) {}
    return { status: r.status, body: d };
  } finally { clearTimeout(timer); }
}

async function login() {
  const r = await withTimeout(api('/api/contest/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'user1', password: 'user123' })
  }), 8000, 'login');
  if (r.status !== 200) throw new Error('login ' + r.status);
  return r.body.token;
}

(async () => {
  try {
    process.stdout.write('STEP=' + step + '\n');
    if (step === 'probe') {
      const r = await withTimeout(api('/contest/login'), 8000, 'probe');
      process.stdout.write('probe status=' + r.status + '\n');
      return;
    }
    const t = await login();
    process.stdout.write('login ok tokenLen=' + t.length + '\n');
    if (step === 'contests') {
      const c = await withTimeout(api('/api/contest/contests', null, t), 8000, 'contests');
      process.stdout.write('contests status=' + c.status + ' count=' + (c.body.contests || []).length + '\n');
      return;
    }
    const contests = (await withTimeout(api('/api/contest/contests', null, t), 8000, 'contests')).body.contests;
    const cid = contests.find((x) => x.title === 'Browser OJ E2E Test').id;
    const problems = (await withTimeout(api('/api/contest/contests/' + cid + '/problems', null, t), 8000, 'problems')).body.problems;
    const pid = problems.find((x) => x.title === 'A + B').id;
    process.stdout.write('cid=' + cid + ' pid=' + pid + '\n');
    if (step === 'scoreboard') {
      const s = await withTimeout(api('/api/contest/contests/' + cid + '/scoreboard', null, t), 8000, 'scoreboard');
      process.stdout.write('scoreboard status=' + s.status + ' version=' + s.body.snapshot.version + '\n');
      return;
    }
    if (step === 'submit') {
      const code = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;return 0;}';
      const r = await withTimeout(api('/api/contest/contests/' + cid + '/submissions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contestId: cid, problemId: pid, language: 'cpp11', code, clientRequestId: 'ablate' + Date.now() })
      }), 8000, 'submit');
      process.stdout.write('submit status=' + r.status + '\n');
      const sid = r.body.submission && r.body.submission.id;
      for (let i = 0; i < 15; i++) {
        await sleep(600);
        const d = await withTimeout(api('/api/contest/submissions/' + sid, null, t), 8000, 'detail');
        const sub = d.body.submission;
        if (sub && sub.status === 'FINISHED') { process.stdout.write('FINISHED verdict=' + sub.verdict + '\n'); break; }
        process.stdout.write('poll status=' + (sub && sub.status) + '\n');
      }
      return;
    }
  } catch (e) {
    process.stdout.write('EXC: ' + e.message + '\n');
    process.exit(3);
  }
})();
