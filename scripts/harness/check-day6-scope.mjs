import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const allowedFiles = new Set([
  'AGENTS.md',
  'server/public/js/contest/runtime-manifest-python.json',
  'scripts/e2e/day6-readiness-smoke.mjs',
  'scripts/e2e/day6-runtime-catalog.mjs',
  'scripts/harness/check-day6-scope.mjs',
]);

const ignoredPrefixes = ['.codex-remote-attachments/'];
const forbiddenFiles = /(^|\/)(\.env(?:\.|$)|package(?:-lock)?\.json$|server\/data\/|deploy\/.*(?:secret|credential))/i;
const likelySecret = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:JWT_SECRET|OPENAI_API_KEY|CF_API_TOKEN)\s*=\s*[^<$\s][^\s]*)/i;

function changedPaths() {
  const output = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replaceAll('\\', '/'))
    .map((path) => (path.includes(' -> ') ? path.split(' -> ').at(-1) : path))
    .filter((path) => !ignoredPrefixes.some((prefix) => path.startsWith(prefix)));
}

const changed = changedPaths();
const violations = [];

for (const path of changed) {
  if (!allowedFiles.has(path)) violations.push(`OUT_OF_SCOPE ${path}`);
  if (forbiddenFiles.test(path)) violations.push(`FORBIDDEN_FILE ${path}`);
  if (!allowedFiles.has(path)) continue;
  try {
    if (likelySecret.test(readFileSync(path, 'utf8'))) violations.push(`LIKELY_SECRET ${path}`);
  } catch {
    // Deleted files are already represented by the scope check.
  }
}

if (violations.length) {
  console.error('DAY6 HARNESS: FAIL');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`DAY6 HARNESS: PASS (${changed.length} scoped file${changed.length === 1 ? '' : 's'})`);
for (const path of changed) console.log(`- ${path}`);
