const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:3001');

async function request(path, expectation) {
  const startedAt = performance.now();
  const response = await fetch(new URL(path, baseUrl), {
    signal: AbortSignal.timeout(10_000),
    redirect: 'follow',
  });
  const body = await response.text();
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  expectation(body, response);
  console.log(`PASS ${path} (${response.status}, ${elapsedMs} ms, ${body.length} chars)`);
}

await request('/healthz', (body) => {
  if (JSON.parse(body).status !== 'ok') throw new Error('/healthz is not ok');
});

await request('/readyz', (body) => {
  if (JSON.parse(body).status !== 'ready') throw new Error('/readyz is not ready');
});

await request('/contest', (body) => {
  if (!/<html[\s>]/i.test(body) || !/Mini-OJ|WebJudge/i.test(body)) {
    throw new Error('/contest did not return the contestant HTML shell');
  }
});

await request('/api/public/runtime-profiles', (body) => {
  const ids = new Set(JSON.parse(body).profiles?.map((profile) => profile.id));
  for (const id of ['c11', 'cpp11', 'c17', 'cpp17', 'python3', 'java21']) {
    if (!ids.has(id)) throw new Error(`runtime profile missing: ${id}`);
  }
});

console.log(`RELEASE READINESS SMOKE: PASS ${baseUrl.origin}`);
