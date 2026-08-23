import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = process.env.CPP17_SSH_HOST || '';
if (!HOST) throw new Error('Set CPP17_SSH_HOST to your GCC 14 reference server');
const OUT = join(ROOT, 'compat-tests', 'cpp17', 'bits', 'gcc14-reference-headers.json');
const SHIM = join(ROOT, 'compat-tests', 'cpp17', 'bits', 'include', 'bits', 'stdc++.h');
const remote = [
  'set -eu',
  'd=$(mktemp -d /tmp/mini-bits-ref.XXXXXX)',
  'trap \u0027rm -rf "$d"\u0027 EXIT',
  'printf \u0027#include <bits/stdc++.h>\\n\u0027 > "$d/probe.cpp"',
  'g++-14 --version | head -1',
  'g++-14 -std=c++17 -H -E "$d/probe.cpp" >/dev/null 2>"$d/headers"',
  'header=$(sed -n \u0027s/^\\.* //p\u0027 "$d/headers" | grep \u0027/bits/stdc++.h$\u0027 | head -1)',
  'printf \u0027__BITS_PATH__=%s\\n\u0027 "$header"',
  'sha256sum "$header" | sed \u0027s/^/__BITS_SHA256__=/\u0027',
  'sed -n \u0027s/^\\.* //p\u0027 "$d/headers"'
].join('\n');
const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST, remote], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000
});
if (result.status !== 0) throw new Error(result.stderr || result.stdout || `ssh exited ${result.status}`);
const lines = result.stdout.replace(/\r/g, '').split('\n').filter(Boolean);
const compilerVersion = lines.shift() || '';
const bitsPath = String(lines.find(line => line.startsWith('__BITS_PATH__=')) || '').slice(14);
const bitsShaLine = lines.find(line => line.startsWith('__BITS_SHA256__=')) || '';
const bitsSha256 = (bitsShaLine.match(/[a-f0-9]{64}/i) || [null])[0];
const closure = [...new Set(lines.filter(line => !line.startsWith('__BITS_')).map(line => line.trim()))].sort();
const shimBody = readFileSync(SHIM, 'utf8');
const shimHeaders = [...shimBody.matchAll(/^#include\s+<([^>]+)>/gm)].map(match => match[1]);
const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  host: HOST,
  compilerVersion,
  command: 'g++-14 -std=c++17 -H -E probe.cpp',
  nativeBits: {path: bitsPath, sha256: bitsSha256, transitiveHeaderCount: closure.length, transitiveHeaders: closure},
  modernShim: {
    path: 'compat-tests/cpp17/bits/include/bits/stdc++.h',
    sha256: createHash('sha256').update(shimBody).digest('hex'),
    supportedStandardHeaders: shimHeaders,
    headerCount: shimHeaders.length,
    policy: 'libc++/WASI supported standard headers only; GNU-only APIs are not emulated'
  },
  status: compilerVersion.includes('14.2.0') && bitsPath && bitsSha256 && closure.length > 0 ? 'PASS' : 'FAIL'
};
mkdirSync(dirname(OUT), {recursive: true});
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
console.log(`modern-bits-reference: ${payload.status} (${closure.length} native headers, ${shimHeaders.length} shim headers)`);
if (payload.status !== 'PASS') process.exitCode = 1;
