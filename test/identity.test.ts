import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, example, postgresExample } from '../src/server.ts';
import { Client, testPassword, testBootstrap } from './fixtures/identity.ts';
import type { Role } from '../src/auth.ts';
import type { Run } from '../src/store.ts';
import { Store } from '../src/store.ts';

async function fixture(setup = true) {
  const directory = await mkdtemp(join(tmpdir(), 'repropack-identity-')), key = testBootstrap();
  const app = await createApp(directory, { bootstrapToken: key });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const client = new Client(`http://127.0.0.1:${address.port}`);
  if (setup) await client.setup(key);
  const db = new DatabaseSync(join(directory, 'runs.sqlite'));
  return { app, directory, key, client, db, async close() { db.close(); await app.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
async function invite(client: Client, address: string, role: Exclude<Role, 'owner'> = 'member') {
  const response = await client.request('/api/team/invites', { email: address, role }); assert.equal(response.status, 201, await response.clone().text());
  const created = await response.json() as { id: string; url: string };
  return { ...created, token: new URL(created.url).hash.slice('#invite='.length) };
}
async function teammate(client: Client, address: string, role: Exclude<Role, 'owner'> = 'member') {
  const invitation = await invite(client, address, role); const member = new Client(client.origin);
  assert.equal((await member.request('/api/invites/accept', { token: invitation.token, name: address.split('@')[0], password: testPassword })).status, 200);
  const view = await member.session(); return { client: member, userId: view.user!.id };
}
async function finished(client: Client, id: string) {
  for (let i = 0; i < 1200; i++) {
    const response = await client.request(`/api/runs/${id}`); assert.equal(response.status, 200);
    const run = await response.json() as Run;
    if (!['queued', 'running'].includes(run.status)) return run;
    await delay(25);
  }
  throw new Error('Replay did not finish');
}

test('closed setup, private cookies and CSRF gates protect every workbench API', async () => {
  const f = await fixture(false);
  try {
    const guest = f.client;
    for (const path of ['/api/runtime', '/api/example', '/api/examples/postgres', '/api/runs', '/api/team', '/api/team/audit', `/api/runs/${randomUUID()}/report`]) assert.equal((await guest.request(path)).status, 401, path);
    assert.deepEqual(await guest.session(), { setupRequired: true });
    assert.equal((await guest.request('/api/auth/setup', { token: '0'.repeat(64) })).status, 403);
    const initialized = await guest.request('/api/auth/setup', { token: f.key, name: 'Owner', email: 'OWNER@example.test', password: testPassword, teamName: 'Research' });
    assert.equal(initialized.status, 201);
    assert.match(initialized.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/u);
    assert.doesNotMatch(initialized.headers.get('set-cookie')!, /Domain=|Max-Age=/u);
    const view = await guest.session(); assert.equal(view.user!.email, 'owner@example.test'); assert.equal(view.team!.role, 'owner');
    await assert.rejects(access(f.app.bootstrapPath));
    assert.equal((await guest.request('/api/auth/setup', { token: f.key })).status, 409);
    assert.equal((await guest.request('/api/teams', { name: 'No CSRF' }, { 'x-repropack-csrf': '' })).status, 403);
    assert.equal((await guest.request('/api/teams', { name: 'Cross-origin' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await guest.request('/api/teams', { name: 'Forged' }, { 'x-repropack-csrf': 'a'.repeat(64) })).status, 403);
    assert.equal((await guest.request('/api/teams', { name: 'Injected role', role: 'owner' })).status, 400);
    const secrets = JSON.stringify(f.db.prepare('SELECT * FROM users').all()) + JSON.stringify(f.db.prepare('SELECT * FROM sessions').all()) + JSON.stringify(f.db.prepare('SELECT * FROM audit').all());
    for (const value of [testPassword, f.key, guest.cookie.split('=')[1]!]) assert.ok(!secrets.includes(value));
    assert.match(f.db.prepare('SELECT password FROM users').get()!.password as string, /^scrypt\$/u);
    assert.equal((await guest.request('/api/auth/logout', {})).status, 200);
    assert.equal((await guest.request('/api/runs')).status, 401);
  } finally { await f.close(); }
});

test('simultaneous valid bootstrap requests create exactly one administrator and team', async () => {
  const f = await fixture(false);
  try {
    const input = { token: f.key, name: 'Owner', email: 'owner@example.test', password: testPassword, teamName: 'One team' };
    const responses = await Promise.all([f.client.request('/api/auth/setup', input), new Client(f.client.origin).request('/api/auth/setup', input)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memberships').get()!.n, 1);
  } finally { await f.close(); }
});

test('explicit HTTPS ingress sets host-only Secure cookies and never trusts forwarded origin headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repropack-tls-')), key = testBootstrap();
  await assert.rejects(createApp(directory, { publicOrigin: 'http://example.test' }), /HTTPS/u);
  const app = await createApp(directory, { publicOrigin: 'https://repropack.example.test', bootstrapToken: key });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const client = new Client(`http://127.0.0.1:${address.port}`);
  try {
    assert.equal((await client.request('/api/session', undefined, { 'x-forwarded-host': 'repropack.example.test', 'x-forwarded-proto': 'https' })).status, 403);
    const response = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const request = httpRequest(`${client.origin}/api/auth/setup`, { method: 'POST', headers: { host: 'repropack.example.test', origin: 'https://repropack.example.test', 'content-type': 'application/json', 'x-repropack-local': '1' } }, response => {
        response.resume(); response.once('end', () => resolve({ status: response.statusCode!, cookie: response.headers['set-cookie']?.[0] ?? '' }));
      });
      request.once('error', reject); request.end(JSON.stringify({ token: key, name: 'TLS Owner', email: 'owner@example.test', password: testPassword, teamName: 'TLS team' }));
    });
    assert.equal(response.status, 201); assert.match(response.cookie, /^__Host-repropack-session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Secure$/u);
    assert.equal((await client.request('/api/session', undefined, { host: 'repropack.example.test', origin: 'http://repropack.example.test' })).status, 403);
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent submissions cannot bypass per-user and per-team queue bounds', async () => {
  const f = await fixture();
  try {
    const capsule = await example();
    const responses = await Promise.all(Array.from({ length: 5 }, () => f.client.request('/api/runs', { capsule })));
    assert.deepEqual(responses.map(response => response.status).sort(), [202, 202, 429, 429, 429]);
    for (const response of responses.filter(response => response.status === 202)) {
      const { id } = await response.json() as { id: string }; assert.equal((await f.client.request(`/api/runs/${id}/cancel`, {})).status, 200);
      assert.equal((await finished(f.client, id)).status, 'cancelled');
    }
  } finally { await f.close(); }
});

test('storage refuses to move an existing run between teams even with a colliding ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repropack-store-scope-')); const store = new Store(directory);
  try {
    const run: Run = { id: randomUUID(), createdAt: new Date().toISOString(), status: 'completed', source: await example(), events: [], teamId: randomUUID(), createdBy: randomUUID() };
    store.save(run); const otherTeam = randomUUID();
    assert.throws(() => store.save({ ...run, teamId: otherTeam }), /ownership is immutable/u);
    assert.equal(store.get(run.id, otherTeam), undefined); assert.equal(store.get(run.id, run.teamId)?.teamId, run.teamId);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('active-team scope blocks history, evidence, cancellation, verification and forged tenant IDs', async () => {
  const f = await fixture();
  try {
    const teamA = (await f.client.session()).team!.id;
    const response = await f.client.request('/api/runs', { capsule: await example(), maxTrials: 6 }); assert.equal(response.status, 202);
    const { id } = await response.json() as { id: string }; await finished(f.client, id);
    const oldCookie = f.client.cookie;
    assert.equal((await f.client.request('/api/teams', { name: 'Private second team' })).status, 201); await f.client.session();
    const teamB = (await f.client.session()).team!.id; assert.notEqual(teamA, teamB); assert.notEqual(f.client.cookie, oldCookie);
    const oldSession = new Client(f.client.origin); oldSession.cookie = oldCookie;
    assert.equal((await oldSession.request('/api/runs')).status, 401);
    assert.deepEqual(await (await f.client.request('/api/runs')).json(), []);
    for (const suffix of ['', '/capsule', '/report']) assert.equal((await f.client.request(`/api/runs/${id}${suffix}`, undefined, { 'x-team-id': teamA })).status, 404);
    for (const suffix of ['/cancel', '/verify']) assert.equal((await f.client.request(`/api/runs/${id}${suffix}`, {})).status, 404);
    assert.equal((await f.client.request('/api/runs', { capsule: await example(), teamId: teamA })).status, 400);
    const stranger = randomUUID(); assert.equal((await f.client.request('/api/teams/switch', { teamId: stranger })).status, 404);
    assert.equal((await f.client.request('/api/teams/switch', { teamId: teamA })).status, 200); await f.client.session();
    assert.equal((await f.client.request(`/api/runs/${id}`)).status, 200);
    const events = await (await f.client.request('/api/team/audit')).json() as { target: string }[];
    assert.ok(events.some(event => event.target === id)); assert.ok(!events.some(event => event.target === teamB));
  } finally { await f.close(); }
});

test('viewer and admin permissions are enforced on the server and demotion revokes sessions', async () => {
  const f = await fixture();
  try {
    const viewer = await teammate(f.client, 'reader@example.test', 'viewer');
    assert.equal((await viewer.client.request('/api/runs')).status, 200);
    assert.equal((await viewer.client.request('/api/runs', { capsule: await example() })).status, 403);
    for (const path of ['/api/team', '/api/team/audit']) assert.equal((await viewer.client.request(path)).status, 403);
    assert.equal((await viewer.client.request('/api/team/invites', { email: 'other@example.test', role: 'admin' })).status, 403);
    const admin = await teammate(f.client, 'admin@example.test', 'admin');
    const ownerId = (await f.client.session()).user!.id;
    assert.equal((await admin.client.request('/api/team/invites', { email: 'another-admin@example.test', role: 'admin' })).status, 403);
    assert.equal((await admin.client.request(`/api/team/members/${ownerId}/remove`, {})).status, 403);
    assert.equal((await admin.client.request(`/api/team/members/${viewer.userId}/role`, { role: 'admin' })).status, 403);
    assert.equal((await admin.client.request(`/api/team/members/${viewer.userId}/role`, { role: 'member' })).status, 200);
    assert.equal((await viewer.client.request('/api/runs')).status, 401);
    assert.equal((await viewer.client.login('reader@example.test')).status, 200);
    assert.equal((await viewer.client.session()).team!.role, 'member');
    const started = await viewer.client.request('/api/runs', { capsule: await example() }); assert.equal(started.status, 202);
    const { id } = await started.json() as { id: string };
    assert.equal((await f.client.request(`/api/team/members/${viewer.userId}/role`, { role: 'viewer' })).status, 200);
    const run = await finished(f.client, id); assert.equal(run.status, 'cancelled'); assert.equal(run.report?.finalVerified, false);
    assert.equal((await viewer.client.request('/api/runs')).status, 401);
    await viewer.client.login('reader@example.test');
    assert.equal((await viewer.client.request(`/api/runs/${id}/cancel`, {})).status, 403);
    assert.equal((await viewer.client.request(`/api/runs/${id}/verify`, {})).status, 403);
    const issuedByAdmin = await invite(admin.client, 'future@example.test');
    assert.equal((await f.client.request(`/api/team/members/${admin.userId}/remove`, {})).status, 200);
    assert.equal((await admin.client.request('/api/team')).status, 401);
    assert.equal((await new Client(f.client.origin).request('/api/invites/inspect', { token: issuedByAdmin.token })).status, 410);
  } finally { await f.close(); }
});

test('invites are hashed, scoped, revocable, expiring and single-use without replacing an existing password', async () => {
  const f = await fixture();
  try {
    const guest = new Client(f.client.origin);
    const old = await invite(f.client, 'new@example.test'), latest = await invite(f.client, 'new@example.test');
    assert.equal((await guest.request('/api/invites/inspect', { token: old.token })).status, 410);
    assert.equal((await f.client.request(`/api/team/invites/${latest.id}/revoke`, {})).status, 200);
    assert.equal((await guest.request('/api/invites/accept', { token: latest.token, name: 'New', password: testPassword })).status, 410);
    const expired = await invite(f.client, 'expired@example.test'); f.db.prepare('UPDATE invitations SET expires_at = 0 WHERE id = ?').run(expired.id);
    assert.equal((await guest.request('/api/invites/inspect', { token: expired.token })).status, 410);
    const usable = await invite(f.client, 'new@example.test');
    const persisted = JSON.stringify(f.db.prepare('SELECT * FROM invitations').all()) + JSON.stringify(f.db.prepare('SELECT * FROM audit').all()); assert.ok(!persisted.includes(usable.token));
    assert.equal((await guest.request('/api/invites/accept', { token: usable.token, name: 'New', password: testPassword })).status, 200); await guest.session();
    assert.equal((await guest.request('/api/invites/accept', { token: usable.token, name: 'Changed', password: 'attacker password would not replace it' })).status, 410);
    assert.equal((await guest.request('/api/teams', { name: 'Second team' })).status, 201); await guest.session();
    const existing = await invite(guest, 'owner@example.test');
    const anonymous = new Client(f.client.origin);
    assert.equal((await anonymous.request('/api/invites/accept', { token: existing.token, name: 'Imposter', password: testPassword })).status, 409);
    assert.equal((await guest.request('/api/invites/accept', { token: existing.token })).status, 409);
    assert.equal((await f.client.request('/api/invites/accept', { token: existing.token })).status, 200); await f.client.session();
    assert.equal((await f.client.session()).team!.role, 'member');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get()!.n, 2);
  } finally { await f.close(); }
});

test('password changes rotate the session and CSRF token, revoke other sessions and enforce expiry', async () => {
  const f = await fixture();
  try {
    const other = new Client(f.client.origin); assert.equal((await other.login()).status, 200);
    const originalCookie = f.client.cookie, originalCsrf = f.client.csrf;
    assert.equal((await f.client.request('/api/auth/password', { currentPassword: 'wrong', password: 'a different lengthy test password' })).status, 403);
    assert.equal((await f.client.request('/api/auth/password', { currentPassword: testPassword, password: 'a different lengthy test password' })).status, 200);
    await f.client.session(); assert.notEqual(f.client.cookie, originalCookie); assert.notEqual(f.client.csrf, originalCsrf);
    assert.equal((await other.request('/api/runs')).status, 401);
    assert.equal((await f.client.request('/api/teams', { name: 'Stale CSRF' }, { 'x-repropack-csrf': originalCsrf })).status, 403);
    assert.equal((await other.login()).status, 401); assert.equal((await other.login('owner@example.test', 'a different lengthy test password')).status, 200);
    f.db.prepare('UPDATE sessions SET last_seen = 0 WHERE hash = ?').run(createHash('sha256').update(other.cookie.split('=')[1]!).digest('hex'));
    assert.equal((await other.request('/api/runs')).status, 401);
    f.db.prepare('UPDATE sessions SET expires_at = 0').run(); assert.equal((await f.client.request('/api/runs')).status, 401);
  } finally { await f.close(); }
});

test('ownership transfer is atomic, requires reauthentication and cannot leave a team ownerless', async () => {
  const f = await fixture();
  try {
    const target = await teammate(f.client, 'successor@example.test'); const ownerId = (await f.client.session()).user!.id;
    assert.equal((await f.client.request(`/api/team/members/${ownerId}/remove`, {})).status, 403);
    assert.equal((await f.client.request(`/api/team/members/${ownerId}/role`, { role: 'admin' })).status, 403);
    assert.equal((await f.client.request('/api/team/transfer', { userId: target.userId, currentPassword: 'incorrect' })).status, 403);
    assert.equal((await f.client.request('/api/team/transfer', { userId: target.userId, currentPassword: testPassword })).status, 200);
    assert.equal((await f.client.request('/api/team')).status, 401); assert.equal((await target.client.request('/api/team')).status, 401);
    await target.client.login('successor@example.test'); assert.equal((await target.client.session()).team!.role, 'owner');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM memberships WHERE role = 'owner'").get()!.n, 1);
    await f.client.login(); assert.equal((await f.client.session()).team!.role, 'admin');
    assert.equal((await f.client.request('/api/team/transfer', { userId: ownerId, currentPassword: testPassword })).status, 403);
  } finally { await f.close(); }
});

test('login throttling survives a server restart and prevents another expensive password check', async () => {
  const f = await fixture(); let reopened: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const key = createHash('sha256').update('account:owner@example.test').digest('hex');
    f.db.prepare('INSERT OR REPLACE INTO auth_limits VALUES (?,9,?)').run(key, Date.now() + 15 * 60_000);
    const stranger = new Client(f.client.origin);
    assert.equal((await stranger.login('owner@example.test', 'wrong')).status, 401);
    assert.equal((await stranger.login()).status, 429);
    await f.app.dispose(); reopened = await createApp(f.directory);
    reopened.server.listen(0, '127.0.0.1'); await once(reopened.server, 'listening');
    const address = reopened.server.address(); assert(address && typeof address !== 'string');
    assert.equal((await new Client(`http://127.0.0.1:${address.port}`).login()).status, 429);
    assert.equal(f.db.prepare('SELECT attempts FROM auth_limits WHERE key = ?').get(key)!.attempts, 10);
  } finally { f.db.close(); if (reopened) await reopened.dispose(); else await f.app.dispose(); await rm(f.directory, { recursive: true, force: true }); }
});

test('legacy runs stay quarantined until an owner explicitly imports them with a password', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repropack-legacy-')); const key = testBootstrap(), id = randomUUID();
  const legacy = new DatabaseSync(join(directory, 'runs.sqlite'));
  legacy.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)');
  const run = { id, createdAt: new Date().toISOString(), status: 'running', source: await example(), events: [] };
  legacy.prepare('INSERT INTO runs VALUES (?,?,?)').run(id, run.createdAt, JSON.stringify(run)); legacy.close();
  const app = await createApp(directory, { bootstrapToken: key }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert(address && typeof address !== 'string'); const client = new Client(`http://127.0.0.1:${address.port}`);
  try {
    const view = await client.setup(key); assert.equal(view.legacyRuns, 1);
    assert.equal((await client.request(`/api/runs/${id}`)).status, 404); assert.deepEqual(await (await client.request('/api/runs')).json(), []);
    assert.equal((await client.request('/api/team/import-local-history', { currentPassword: 'wrong' })).status, 403);
    assert.equal((await client.request('/api/team/import-local-history', { currentPassword: testPassword })).status, 200);
    const imported = await (await client.request(`/api/runs/${id}`)).json() as Run; assert.equal(imported.status, 'interrupted'); assert.equal(imported.teamId, view.team!.id); assert.equal(imported.createdBy, view.user!.id);
    assert.equal((await client.session()).legacyRuns, 0);
    await client.request('/api/teams', { name: 'Unrelated team' }); await client.session(); assert.equal((await client.request(`/api/runs/${id}`)).status, 404);
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('operator application bindings cannot expose a custom application to another team', async () => {
  const f = await fixture(); let reopened: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const teamId = (await f.client.session()).team!.id;
    const configDirectory = join(f.directory, 'registered'); await cp(new URL('../examples/postgres-app/', import.meta.url), configDirectory, { recursive: true });
    const configPath = join(configDirectory, 'repropack.json'); const config = JSON.parse(await readFile(configPath, 'utf8')) as { id: string }; config.id = 'private-application'; await writeFile(configPath, JSON.stringify(config));
    await assert.rejects(createApp(f.directory, { applicationConfig: configPath }), /REPROPACK_APP_TEAM_ID/u);
    await f.app.dispose(); reopened = await createApp(f.directory, { applicationConfig: configPath, applicationTeamId: teamId });
    reopened.server.listen(0, '127.0.0.1'); await once(reopened.server, 'listening'); const address = reopened.server.address(); assert(address && typeof address !== 'string');
    const client = new Client(`http://127.0.0.1:${address.port}`); await client.login();
    const bound = await (await client.request('/api/runtime')).json() as { applications: Record<string, string> }; assert.equal(bound.applications['private-application'], 'trusted-native');
    await client.request('/api/teams', { name: 'No private source' }); await client.session();
    const other = await (await client.request('/api/runtime')).json() as { applications: Record<string, string> }; assert.equal(other.applications['private-application'], undefined);
    assert.equal((await client.request('/api/runs', { capsule: { ...await postgresExample(), application: 'private-application' } })).status, 400);
  } finally { f.db.close(); if (reopened) await reopened.dispose(); else await f.app.dispose(); await rm(f.directory, { recursive: true, force: true }); }
});

test('two teams never reuse a frozen PostgreSQL snapshot, including when switching back', { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    const teamA = (await f.client.session()).team!.id;
    const replay = async () => {
      const response = await f.client.request('/api/runs', { capsule: await postgresExample(), maxTrials: 6 }); assert.equal(response.status, 202);
      const { id } = await response.json() as { id: string }; return finished(f.client, id);
    };
    const first = await replay(); assert.equal(first.status, 'budget_exhausted', first.error ?? first.report?.reason); assert.equal(first.environment?.totalRows, 4);
    await f.client.request('/api/teams', { name: 'Independent snapshot' }); await f.client.session();
    const second = await replay(); assert.equal(second.status, 'budget_exhausted', second.error ?? second.report?.reason); assert.equal(second.environment?.totalRows, 4);
    assert.notEqual(first.environment?.snapshotSha256, second.environment?.snapshotSha256, 'Masking salt and frozen snapshot belong to a team registry');
    await f.client.request('/api/teams/switch', { teamId: teamA }); await f.client.session();
    const again = await replay(); assert.equal(again.environment?.snapshotSha256, first.environment?.snapshotSha256, 'Switching teams does not replace the original frozen snapshot');
    assert.equal((await f.client.request(`/api/runs/${second.id}`)).status, 404);
  } finally { await f.close(); }
});
