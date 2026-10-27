import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const meta = JSON.parse(await readFile('package.json', 'utf8'));
const archive = path.resolve(process.env.REPROPACK_SOURCE_ARCHIVE || `artifacts/release/repropack-${meta.version}.tgz`);
const archiveBytes = await readFile(archive), sha = createHash('sha256').update(archiveBytes).digest('hex');
assert.equal(sha, (await readFile(archive + '.sha256', 'utf8')).split(' ')[0]);
const tar = gunzipSync(archiveBytes, { maxOutputLength: 16 * 1024 * 1024 }), entries = new Map();
const prefix = `repropack-${meta.version}/`;
for (let offset = 0; offset < tar.length && tar[offset] !== 0;) {
  const header = tar.subarray(offset, offset + 512), field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/su, '');
  const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/'), size = parseInt(field(124, 12), 8);
  assert.ok(name.startsWith(prefix) && ['0', '\0'].includes(field(156, 1)));
  const relative = name.slice(prefix.length);
  assert.ok(/^[a-zA-Z0-9_./-]+$/u.test(relative) && !relative.split('/').some(part => !part || part === '.' || part === '..'));
  assert.ok(!entries.has(relative) && Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length && entries.size < 500);
  entries.set(relative, tar.subarray(offset + 512, offset + 512 + size)); offset += 512 + Math.ceil(size / 512) * 512;
}
const manifest = JSON.parse(entries.get('RELEASE-MANIFEST.json')?.toString() || 'null');
assert.equal(manifest?.version, meta.version); assert.equal(manifest.files.length + 1, entries.size);
const names = new Set();
for (const file of manifest.files) {
  const bytes = entries.get(file.path); assert.ok(bytes && !names.has(file.path)); names.add(file.path);
  assert.equal(bytes.length, file.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}
const parent = path.resolve('artifacts/clean-install'); await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, 'install-'));
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: work, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => child.kill(), 180000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes.toString()).slice(-6000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(Error('Fresh source check failed: ' + output)); });
  });
}
try {
  for (const [relative, bytes] of entries) {
    const target = path.resolve(work, relative); assert.ok(target.startsWith(work + path.sep));
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' });
  }
  if (!process.env.npm_execpath) throw Error('Run npm run test:release');
  await run([process.env.npm_execpath, 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  await run(['scripts/build.mjs']);
  await run(['scripts/demo-browser-smoke.mjs']);
  const browser = JSON.parse(await readFile(path.join(work, 'artifacts/demo-browser/deletion-evidence-report.json'), 'utf8'));
  assert.equal(browser.status, 'passed'); assert.equal(browser.checks.length, 6);
  const report = { status: 'passed', version: meta.version, archiveSha256: sha, sourceFiles: manifest.files.length, manifest: 'verified', freshNodeModules: true, demoBrowser: 'passed', deletionEvidenceChecks: browser.checks.length, credentialsCopied: false, scope: 'Fresh source/build/synthetic HTTP demo; full PostgreSQL installation, sandbox and live hosting are separate gates' };
  await writeFile(path.join(parent, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally {
  assert.equal(path.dirname(work), parent); assert.ok(path.basename(work).startsWith('install-'));
  await rm(work, { recursive: true, force: true });
}
