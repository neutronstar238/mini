'use strict';
const B = 'http://localhost:3001';
(async () => {
  try {
    const r = await fetch(B + '/api/contest/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'user1', password: 'user123' })
    });
    console.log('login status:', r.status);
    const j = await r.json();
    const t = j.token;
    const api = async (path, o, tok) => {
      const rr = await fetch(B + path, Object.assign({}, o, { headers: Object.assign({ 'Content-Type': 'application/json' }, (o && o.headers) || {}, tok ? { Authorization: 'Bearer ' + tok } : {}) }));
      let d = {}; try { d = await rr.json(); } catch (_) {}
      return { status: rr.status, body: d, headers: rr.headers };
    };
    const c = (await api('/api/contest/contests', null, t)).body.contests;
    const cid = c.find((x) => x.title === 'Browser OJ E2E Test').id;
    const sb = await api('/api/contest/contests/' + cid + '/scoreboard', null, t);
    const snap = sb.body.snapshot;
    const leak = JSON.stringify(snap).match(/sourceCode|testcases|compileMessage|password/i);
    console.log('1. scoreboard:', sb.status, 'version', snap.version, 'participants', snap.participants.length, 'leak', leak ? ('YES:' + leak[0]) : 'none');
    let got429 = false;
    for (let i = 0; i < 30; i++) {
      const r = await api('/api/contest/contests/' + cid + '/scoreboard', null, t);
      if (r.status === 429) { got429 = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    console.log('2. rate-limit 429:', got429 ? 'YES' : 'NO');
    const at = (await api('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).body.token;
    const subs = await api('/api/admin/contests/' + cid + '/submissions?page=1&pageSize=3', null, at);
    console.log('3. admin query:', subs.status, 'total', subs.body.total, 'hasSourceInList', ('sourceCode' in (subs.body.submissions && subs.body.submissions[0] || {})));
    const sid = subs.body.submissions && subs.body.submissions[0] && subs.body.submissions[0].id;
    if (sid) { const det = await api('/api/admin/submissions/' + sid, null, at); console.log('4. admin detail hasSource:', !!det.body.submission && det.body.submission.sourceCode !== undefined, 'verdict', det.body.submission && det.body.submission.verdict); }
    const metrics = await api('/api/contest/_metrics', null, at);
    console.log('5. metrics:', JSON.stringify(metrics.body.metrics));
    console.log('SMOKE OK');
  } catch (e) { console.error('ERR:', e.message); process.exit(1); }
})();
