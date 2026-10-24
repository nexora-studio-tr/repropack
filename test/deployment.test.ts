import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, example, postgresExample } from '../src/server.ts';
import { Client, testBootstrap } from './fixtures/identity.ts';
import type { Run } from '../src/store.ts';
import { ownedPreviewId, requireDemoContainer } from '../src/deployment/preview-policy.ts';
import type { PreviewLease } from '../src/deployment/preview-policy.ts';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(demoMode = true) {
  const directory = await mkdtemp(join(tmpdir(), 'repropack-deployment-')), key = testBootstrap();
  const app = await createApp(directory, demoMode ? { demoMode } : { bootstrapToken: key });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const address = app.server.address(); assert(address && typeof address !== 'string');
  const client = new Client(`http://127.0.0.1:${address.port}`), db = new DatabaseSync(join(directory, 'runs.sqlite'));
  return { app, directory, client, key, db, async close() { db.close(); await app.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
async function guest(origin: string) {
  const client = new Client(origin); assert.equal((await client.request('/api/demo/session', {})).status, 201); await client.session(); return client;
}
async function finished(client: Client, id: string) {
  for (let i = 0; i < 600; i++) { const response = await client.request(`/api/runs/${id}`); assert.equal(response.status, 200); const run = await response.json() as Run; if (!['running', 'queued'].includes(run.status)) return run; await delay(25); }
  throw new Error('Demo did not finish');
}
test('demo starts without setup and exposes only a minimal unauthenticated health check', async () => {
  const f = await fixture();
  try {
    const view = await f.client.session(); assert.equal(view.setupRequired, false); assert.equal(view.demo?.ttlMinutes, 60); assert.equal(view.demo?.maxOperations, 10);
    await assert.rejects(access(f.app.bootstrapPath));
    assert.deepEqual(await (await fetch(`${f.client.origin}/healthz`)).json(), { status: 'ok' });
    assert.equal((await f.client.request('/api/runs')).status, 401);
    assert.equal((await fetch(`${f.client.origin}/api/demo/session`, { method: 'POST' })).status, 403);
    await assert.rejects(createApp(f.directory, { demoMode: true }), /new disposable directory/u);
    const next = join(f.directory, 'blocked'); await mkdir(next);
    await assert.rejects(createApp(next, { demoMode: true, applicationConfig: 'untrusted' }), /operator applications/u);
  } finally { await f.close(); }
});
test('visitors get separate real reduction evidence and cannot administer accounts or upload other workloads', async () => {
  const f = await fixture();
  try {
    const a = await guest(f.client.origin), b = await guest(f.client.origin);
    assert.notEqual((await a.session()).team!.id, (await b.session()).team!.id);
    assert.deepEqual(await (await a.request('/api/runtime')).json(), { applications: {} });
    assert.equal((await a.request('/api/examples/postgres')).status, 403);
    for (const [path, body] of [['/api/auth/setup', {}], ['/api/auth/login', {}], ['/api/auth/password', {}], ['/api/teams', { name: 'Escaped' }], ['/api/invites/accept', {}], ['/api/team/invites', {}]] as const) assert.equal((await a.request(path, body)).status, 403, path);
    assert.equal((await a.request('/api/team/audit')).status, 403);
    assert.equal((await a.request('/api/runs', { capsule: { ...await example(), title: 'Changed' } })).status, 400);
    assert.equal((await a.request('/api/runs', { capsule: await postgresExample() })).status, 400);
    assert.equal((await a.request('/api/runs', { capsule: await example(), maxTrials: 500 })).status, 400);
    const response = await a.request('/api/runs', { capsule: await example() }); assert.equal(response.status, 202); const { id } = await response.json() as { id: string };
    const run = await finished(a, id); assert.equal(run.status, 'completed'); assert.equal(run.report?.reducedSteps, 5);
    assert.equal((await b.request(`/api/runs/${id}`)).status, 404); assert.equal((await b.request(`/api/runs/${id}/report`)).status, 404);
    assert.equal((await b.request(`/api/runs/${id}/cancel`, {})).status, 404); assert.equal((await b.request(`/api/runs/${id}/verify`, {})).status, 404);
    assert.equal((await a.request(`/api/runs/${id}/capsule`)).status, 200);
    const fix = await a.request(`/api/runs/${id}/verify`, {}); assert.equal(fix.status, 200); assert.equal((await fix.json() as { passed: boolean }).passed, true);
    assert.equal(f.db.prepare('SELECT operations FROM demo_visitors WHERE team_id = ?').get(run.teamId)!.operations, 2);
    f.db.prepare('UPDATE demo_visitors SET operations = 10 WHERE team_id = ?').run(run.teamId);
    assert.equal((await a.request('/api/runs', { capsule: await example() })).status, 429); assert.equal((await a.request(`/api/runs/${id}/verify`, {})).status, 429);
  } finally { await f.close(); }
});
test('expiry denies access immediately and deletes only the expired visitor data', async () => {
  const f = await fixture();
  try {
    const a = await guest(f.client.origin), b = await guest(f.client.origin); const teamA = (await a.session()).team!.id, teamB = (await b.session()).team!.id;
    const response = await a.request('/api/runs', { capsule: await example(), maxTrials: 6 }); const { id } = await response.json() as { id: string }; await finished(a, id);
    f.db.prepare('UPDATE demo_visitors SET expires_at = 0 WHERE team_id = ?').run(teamA);
    assert.equal((await a.request(`/api/runs/${id}`)).status, 401);
    await a.session();
    for (const table of ['runs', 'memberships', 'audit', 'sessions', 'demo_visitors']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE team_id = ?`).get(teamA)!.n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get()!.n, 1); assert.equal((await b.session()).team!.id, teamB);
    assert.equal((await b.request('/api/auth/logout', {})).status, 200); await b.session(); assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get()!.n, 0);
  } finally { await f.close(); }
});
test('anonymous demo creation is throttled and the private mode cannot reopen a demo database', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++) await guest(f.client.origin);
    assert.equal((await new Client(f.client.origin).request('/api/demo/session', {})).status, 429);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get()!.n, 10);
    await assert.rejects(createApp(f.directory), /cannot be interchanged/u);
  } finally { await f.close(); }
});
test('a live private SQLite backup restores into a new directory and revokes old sessions and invitations', async () => {
  const f = await fixture(false); let restored: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await f.client.setup(f.key);
    const response = await f.client.request('/api/runs', { capsule: await example(), maxTrials: 6 }); const { id } = await response.json() as { id: string }; await finished(f.client, id);
    await f.client.request('/api/team/invites', { email: 'backup-invite@example.test', role: 'member' });
    f.db.prepare('INSERT INTO account_tokens VALUES (?,?,?,?,?,?)').run('a'.repeat(64), (await f.client.session()).user!.id, 'reset', 'owner@example.test', 'b'.repeat(64), Date.now() + 60_000);
    const saved = await execute(process.execPath, ['scripts/backup.mjs'], { cwd: root, env: { ...process.env, REPROPACK_DATA_DIR: f.directory } });
    const backup = JSON.parse(saved.stdout) as { backup: string; manifest: string }; const target = join(f.directory, 'restored');
    await execute(process.execPath, ['scripts/restore.mjs', backup.backup, target], { cwd: root });
    const copy = new DatabaseSync(join(target, 'runs.sqlite'));
    assert.equal(copy.prepare('SELECT count(*) AS n FROM account_tokens').get()!.n, 0, 'restored recovery links are revoked');
    try { assert.equal(copy.prepare('SELECT count(*) AS n FROM sessions').get()!.n, 0); assert.equal(copy.prepare('SELECT count(*) AS n FROM invitations WHERE used_at IS NULL').get()!.n, 0); assert.equal(copy.prepare('SELECT count(*) AS n FROM runs').get()!.n, 1); } finally { copy.close(); }
    await assert.rejects(execute(process.execPath, ['scripts/restore.mjs', backup.backup, target], { cwd: root }), /EEXIST/u);
    restored = await createApp(target); restored.server.listen(0, '127.0.0.1'); await once(restored.server, 'listening'); const address = restored.server.address(); assert(address && typeof address !== 'string');
    const client = new Client(`http://127.0.0.1:${address.port}`); assert.equal((await client.login()).status, 200); assert.equal((await client.request(`/api/runs/${id}`)).status, 200);
    assert.equal((await f.client.request(`/api/runs/${id}`)).status, 200, 'Original workspace remains usable');
    await writeFile(backup.backup, 'tampered', { flag: 'a' });
    await assert.rejects(execute(process.execPath, ['scripts/restore.mjs', backup.backup, join(f.directory, 'tampered-restore')], { cwd: root }), /checksum/u);
    await assert.rejects(access(join(f.directory, 'tampered-restore')));
  } finally { await restored?.dispose(); await f.close(); }
});
test('the source release includes the lockfile and verified manifest while excluding private/runtime directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repropack-package-'));
  try {
    const result = await execute(process.execPath, ['scripts/package-release.mjs', directory], { cwd: root }); const summary = JSON.parse(result.stdout) as { archive: string; sha256: string; fileCount: number };
    const archive = await readFile(summary.archive); assert.equal(createHash('sha256').update(archive).digest('hex'), summary.sha256);
    const tar = gunzipSync(archive); const entries = new Map<string, Buffer>();
    for (let offset = 0; offset < tar.length && tar[offset] !== 0;) {
      const header = tar.subarray(offset, offset + 512); const string = (start: number, length: number) => header.subarray(start, start + length).toString().replace(/\0.*$/su, '');
      const name = [string(345, 155), string(0, 100)].filter(Boolean).join('/'); const size = parseInt(string(124, 12), 8);
      assert.ok(Number.isFinite(size)); assert.ok(!name.split('/').includes('..')); entries.set(name.slice(name.indexOf('/') + 1), tar.subarray(offset + 512, offset + 512 + size)); offset += 512 + Math.ceil(size / 512) * 512;
    }
    assert.ok(entries.has('package-lock.json')); assert.ok(entries.has('.gitignore')); assert.ok(entries.has('Dockerfile')); assert.ok(entries.has('render.yaml')); assert.ok(entries.has('.env.example'));
    for (const name of entries.keys()) assert.ok(!/^(?:\.repropack|\.git\/|artifacts|node_modules|dist|\.env$)/u.test(name), name);
    const manifest = JSON.parse(entries.get('RELEASE-MANIFEST.json')!.toString()) as { files: { path: string; sha256: string }[] };
    assert.equal(manifest.files.length, summary.fileCount);
    for (const file of manifest.files) assert.equal(createHash('sha256').update(entries.get(file.path)!).digest('hex'), file.sha256);
    await assert.rejects(execute(process.execPath, ['scripts/package-release.mjs', directory], { cwd: root }), /EEXIST/u);
    assert.equal(createHash('sha256').update(await readFile(summary.archive)).digest('hex'), summary.sha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('preview cleanup refuses forged labels and a reused container name', () => {
  const lease: PreviewLease = { owner: randomUUID(), scope: 'a'.repeat(64), engineId: 'engine-original', appImage: `sha256:${'b'.repeat(64)}`, tunnelImage: `sha256:${'c'.repeat(64)}`, resources: [] };
  const resource = { kind: 'web' as const, name: 'owned-preview-web', id: 'd'.repeat(64) };
  const value = { Id: resource.id, Name: `/${resource.name}`, Config: { Labels: { 'io.repropack.preview.owner': lease.owner, 'io.repropack.preview.scope': lease.scope, 'io.repropack.preview.kind': resource.kind } } };
  assert.equal(ownedPreviewId(value, lease, resource), resource.id);
  assert.throws(() => ownedPreviewId({ ...value, Id: 'e'.repeat(64) }, lease, resource), /ownership/u);
  assert.throws(() => ownedPreviewId({ ...value, Config: { Labels: { ...value.Config.Labels, 'io.repropack.preview.owner': randomUUID() } } }, lease, resource), /ownership/u);
  assert.throws(() => ownedPreviewId({ ...value, Config: { Labels: { ...value.Config.Labels, 'io.repropack.preview.scope': 'f'.repeat(64) } } }, lease, resource), /ownership/u);
});
test('public preview requires the dedicated namespace, demo flag and no host data/ports', () => {
  const lease: PreviewLease = { owner: randomUUID(), scope: 'a'.repeat(64), engineId: 'engine-original', appImage: `sha256:${'b'.repeat(64)}`, tunnelImage: `sha256:${'c'.repeat(64)}`, url: 'https://example-only.trycloudflare.com', resources: [] };
  const keeperId = 'd'.repeat(64);
  const value = { Image: lease.appImage, Config: { User: '10001:10001', Env: ['REPROPACK_DEMO=1', `REPROPACK_PUBLIC_ORIGIN=${lease.url}`, 'REPROPACK_DATA_DIR=', 'REPROPACK_DEMO_LIFETIME_MS=7200000'] }, HostConfig: { NetworkMode: `container:${keeperId}`, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges=true'], Binds: [], PortBindings: {}, Memory: 512 * 1024 ** 2, MemorySwap: 512 * 1024 ** 2, NanoCpus: 1e9, PidsLimit: 128 }, Mounts: [] };
  assert.doesNotThrow(() => requireDemoContainer(value, lease, keeperId));
  for (const host of [{ NetworkMode: 'host' }, { ReadonlyRootfs: false }, { Binds: ['/private:/data'] }, { PortBindings: { '4320/tcp': [{}] } }, { Privileged: true }]) assert.throws(() => requireDemoContainer({ ...value, HostConfig: { ...value.HostConfig, ...host } }, lease, keeperId), /isolated demo policy/u);
  assert.throws(() => requireDemoContainer({ ...value, Config: { ...value.Config, Env: ['REPROPACK_DEMO=0'] } }, lease, keeperId), /isolated demo policy/u);
});
