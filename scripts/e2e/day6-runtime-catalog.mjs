import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

const c11 = load('server/public/js/contest/runtime-manifest-c11.json');
const cpp11 = load('server/public/js/contest/runtime-manifest-cpp11.json');
const python = load('server/public/js/contest/runtime-manifest-python.json');
const modern = load('server/public/js/runtime/cpp-modern-engine-v2/runtime-manifest.json');
const java = load('server/public/js/runtime/java21-browserjdk-compat-v2/runtime-manifest.json');

const catalog = [
  ['c11', c11.runtimeId],
  ['cpp11', cpp11.runtimeId],
  ['c17', 'c17-gcc14-compat-v2'],
  ['cpp17', 'cpp17-gcc14-compat-v2'],
  ['python3', python.runtimeId],
  ['java21', java.runtimeId],
];

const runtimeIds = catalog.map(([, runtimeId]) => runtimeId);
if (new Set(runtimeIds).size !== runtimeIds.length) throw new Error('runtimeId values must be unique');

for (const [profileId, runtimeId] of catalog) {
  if (!runtimeId || typeof runtimeId !== 'string') throw new Error(`${profileId} has no runtimeId`);
}

for (const [profileId, standard] of [['c17-gcc14-compat-v2', 'c17'], ['cpp17-gcc14-compat-v2', 'c++17']]) {
  const profile = modern.profiles?.[profileId];
  if (!profile || profile.standard !== standard || typeof profile.submissionEnabled !== 'boolean') {
    throw new Error(`invalid modern runtime profile: ${profileId}`);
  }
}

const pythonAssetBytes = python.assets.files.reduce((sum, asset) => sum + asset.bytes, 0);
if (pythonAssetBytes !== python.assets.totalBytes) {
  throw new Error(`Python asset bytes mismatch: files=${pythonAssetBytes}, totalBytes=${python.assets.totalBytes}`);
}

for (const asset of [...python.assets.files, ...modern.assets, ...java.assets]) {
  const url = asset.url || asset.path || asset.name || asset.file;
  if (/^https?:\/\//i.test(url)) throw new Error(`external runtime asset URL is forbidden: ${url}`);
  if (!Number.isInteger(asset.bytes) || asset.bytes <= 0) throw new Error(`invalid asset byte count: ${url}`);
}

const baseUrl = process.argv[2];
if (baseUrl) {
  const response = await fetch(new URL('/api/public/runtime-profiles', baseUrl), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`runtime profile API returned HTTP ${response.status}`);
  const publicProfiles = new Map((await response.json()).profiles.map((profile) => [profile.id, profile]));
  for (const [profileId, runtimeId] of catalog) {
    const actual = publicProfiles.get(profileId)?.localRuntime?.runtimeId;
    if (actual !== runtimeId) throw new Error(`${profileId} runtimeId drift: local=${runtimeId}, API=${actual}`);
  }
}

console.log('DAY6 RUNTIME CATALOG: PASS');
for (const [profileId, runtimeId] of catalog) console.log(`- ${profileId}: ${runtimeId}`);
console.log(`- Python assets: ${python.assets.files.length} files, ${pythonAssetBytes} bytes`);
