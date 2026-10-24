import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.ts';
import { mailFromEnvironment } from '../src/mail.ts';
import type { AccountMessage } from '../src/mail.ts';
import { Client, testBootstrap, testPassword } from './fixtures/identity.ts';
const nextPassword = 'test-only replacement horse battery staple';
async function fixture(required = false, delivery?: (message: AccountMessage) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'repropack-account-security-')), messages: AccountMessage[] = [], key = testBootstrap();
  const app = await createApp(directory, { bootstrapToken: key, requireVerifiedEmail: required, mailer: { async send(message) { if (delivery) await delivery(message); messages.push(message); } } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const client = new Client('http://127.0.0.1:' + address.port); await client.setup(key);
  const db = new DatabaseSync(join(directory, 'runs.sqlite'));
  return { client, db, messages, async received(count: number) { for (let n = 0; n < 200 && messages.length < count; n++) await delay(10); assert.equal(messages.length, count); return messages[count - 1]!; }, async close() { await app.dispose(); db.close(); await rm(directory, { recursive: true, force: true }); } };
}
function link(message: AccountMessage, kind: 'verify' | 'reset') { const url = new URL(message.text.match(/http[^\s]+/u)![0]); return { url, token: new URLSearchParams(url.hash.slice(1)).get(kind)! }; }

test('required verification blocks workspace APIs until a one-use email link is confirmed', async () => {
  const f = await fixture(true);
  try {
    assert.deepEqual((await f.client.session()).email, { enabled: true, required: true, verified: false });
    for (const path of ['/api/runs', '/api/runtime', '/api/team']) assert.equal((await f.client.request(path)).status, 403);
    const visitor = new Client(f.client.origin);
    assert.equal((await visitor.request('/api/auth/email/request', {})).status, 401);
    assert.equal((await f.client.request('/api/auth/email/request', {}, { 'x-repropack-csrf': '' })).status, 403);
    const response = await f.client.request('/api/auth/email/request', {}); assert.equal(response.status, 202); assert.deepEqual(await response.json(), { accepted: true });
    const sent = await f.received(1), value = link(sent, 'verify'); assert.equal(sent.to, 'owner@example.test');
    assert.equal(value.url.origin, f.client.origin); assert.equal(value.url.search, '');
    const persisted = JSON.stringify(f.db.prepare('SELECT * FROM account_tokens').all()) + JSON.stringify(f.db.prepare('SELECT * FROM audit').all());
    assert.ok(!persisted.includes(value.token)); assert.match(value.token, /^[a-f0-9]{64}$/u);
    assert.equal((await visitor.request('/api/auth/email/confirm')).status, 405);
    assert.equal((await visitor.request('/api/auth/email/confirm', { token: value.token })).status, 200);
    assert.equal((await visitor.request('/api/runs')).status, 401, 'verification does not authenticate the browser');
    assert.equal((await visitor.request('/api/auth/email/confirm', { token: value.token })).status, 410);
    assert.equal((await f.client.session()).email?.verified, true);
    assert.equal((await f.client.request('/api/runs')).status, 200);
  } finally { await f.close(); }
});

test('reissued, expired and wrong-purpose account links fail closed', async () => {
  const f = await fixture();
  try {
    await f.client.request('/api/auth/email/request', {}); const first = link(await f.received(1), 'verify').token;
    await f.client.request('/api/auth/email/request', {}); const second = link(await f.received(2), 'verify').token;
    assert.equal((await f.client.request('/api/auth/email/confirm', { token: first })).status, 410);
    assert.equal((await f.client.request('/api/auth/password/reset', { token: second, password: nextPassword })).status, 410);
    f.db.prepare('UPDATE account_tokens SET expires_at=0').run();
    assert.equal((await f.client.request('/api/auth/email/confirm', { token: second })).status, 410);
    assert.equal((await f.client.session()).email?.verified, false);
  } finally { await f.close(); }
});

test('recovery does not enumerate accounts and resets all sessions without automatic login', async () => {
  const f = await fixture();
  try {
    const peer = new Client(f.client.origin); assert.equal((await peer.login()).status, 200);
    const invitation = await f.client.request('/api/team/invites', { email: 'future@example.test', role: 'viewer' }); assert.equal(invitation.status, 201);
    const guest = new Client(f.client.origin);
    const unknown = await guest.request('/api/auth/password/forgot', { email: 'missing@example.test' });
    const known = await guest.request('/api/auth/password/forgot', { email: 'owner@example.test' });
    assert.equal(known.status, 202); assert.equal(unknown.status, known.status); assert.deepEqual(await unknown.json(), await known.json());
    const value = link(await f.received(1), 'reset').token;
    assert.equal((await f.client.request('/api/runs')).status, 200, 'requesting recovery alone does not revoke access');
    assert.equal((await guest.request('/api/auth/password/reset', { token: value, password: 'short' })).status, 400);
    assert.equal((await guest.request('/api/auth/password/reset', { token: value, password: nextPassword })).status, 200);
    assert.equal((await f.client.request('/api/runs')).status, 401); assert.equal((await peer.request('/api/runs')).status, 401); assert.equal((await guest.request('/api/runs')).status, 401);
    assert.equal((await guest.request('/api/auth/password/reset', { token: value, password: nextPassword })).status, 410);
    assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM account_tokens').get()!.n), 0);
    assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM invitations WHERE used_at IS NULL').get()!.n), 0);
    assert.equal((await guest.login('owner@example.test', testPassword)).status, 401);
    assert.equal((await guest.login('owner@example.test', nextPassword)).status, 200);
    assert.equal((await guest.session()).email?.verified, true);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit WHERE action='password.reset'").get()!.n, 1);
  } finally { await f.close(); }
});

test('simultaneous password resets consume the link exactly once', async () => {
  const f = await fixture();
  try {
    const a = new Client(f.client.origin), b = new Client(f.client.origin);
    await a.request('/api/auth/password/forgot', { email: 'owner@example.test' });
    const token = link(await f.received(1), 'reset').token;
    const responses = await Promise.all([a.request('/api/auth/password/reset', { token, password: nextPassword }), b.request('/api/auth/password/reset', { token, password: nextPassword })]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 410]);
  } finally { await f.close(); }
});

test('password changes invalidate outstanding verification and recovery links', async () => {
  const f = await fixture();
  try {
    await f.client.request('/api/auth/email/request', {}); const verify = link(await f.received(1), 'verify').token;
    await new Client(f.client.origin).request('/api/auth/password/forgot', { email: 'owner@example.test' }); const reset = link(await f.received(2), 'reset').token;
    assert.equal((await f.client.request('/api/auth/password', { currentPassword: testPassword, password: nextPassword })).status, 200); await f.client.session();
    assert.equal((await f.client.request('/api/auth/email/confirm', { token: verify })).status, 410);
    assert.equal((await f.client.request('/api/auth/password/reset', { token: reset, password: testPassword })).status, 410);
  } finally { await f.close(); }
});

test('a recovery link cannot change another user or membership', async () => {
  const f = await fixture();
  try {
    const inviteResponse = await f.client.request('/api/team/invites', { email: 'member@example.test', role: 'viewer' });
    const invite = await inviteResponse.json() as { url: string };
    const member = new Client(f.client.origin);
    assert.equal((await member.request('/api/invites/accept', { token: new URLSearchParams(new URL(invite.url).hash.slice(1)).get('invite'), name: 'Member', password: testPassword })).status, 200);
    const before = JSON.stringify(f.db.prepare('SELECT * FROM memberships ORDER BY user_id').all());
    await member.request('/api/auth/password/forgot', { email: 'member@example.test' }); const token = link(await f.received(1), 'reset').token;
    assert.equal((await member.request('/api/auth/password/reset', { token, password: nextPassword, userId: (await f.client.session()).user!.id })).status, 400);
    assert.equal((await member.request('/api/auth/password/reset', { token, password: nextPassword })).status, 200);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM memberships ORDER BY user_id').all()), before);
    assert.equal((await f.client.request('/api/runs')).status, 200);
  } finally { await f.close(); }
});

test('email delivery is bounded and slow SMTP does not delay the anonymous response', async () => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(false, async () => { await blocked; });
  try {
    const guest = new Client(f.client.origin), response = await guest.request('/api/auth/password/forgot', { email: 'owner@example.test' });
    assert.equal(response.status, 202); assert.equal(f.messages.length, 0);
    for (let i = 0; i < 7; i++) assert.equal((await guest.request('/api/auth/password/forgot', { email: 'owner@example.test' })).status, 202);
    assert.equal((await guest.request('/api/auth/password/forgot', { email: 'owner@example.test' })).status, 429);
  } finally { release(); await f.close(); }
});

test('local and disposable demo modes never expose a fake recovery service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repropack-mail-disabled-'));
  const app = await createApp(directory);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const address = app.server.address(); assert(address && typeof address !== 'string');
  try {
    const client = new Client('http://127.0.0.1:' + address.port);
    assert.equal((await client.session()).email, undefined);
    assert.equal((await client.request('/api/auth/password/forgot', { email: 'owner@example.test' })).status, 503);
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
  const invalid = await mkdtemp(join(tmpdir(), 'repropack-mail-required-'));
  try { await assert.rejects(createApp(invalid, { requireVerifiedEmail: true }), /SMTP/u); }
  finally { await rm(invalid, { recursive: true, force: true }); }
});

test('SMTP configuration rejects partial settings and refuses plaintext authentication', async () => {
  assert.equal(mailFromEnvironment({}), undefined);
  assert.equal(mailFromEnvironment({ REPROPACK_SMTP_HOST: '', REPROPACK_SMTP_PORT: '', REPROPACK_SMTP_SECURE: '', REPROPACK_MAIL_FROM: '' }), undefined);
  const defaultTransport = mailFromEnvironment({ REPROPACK_SMTP_HOST: 'smtp.example.test', REPROPACK_SMTP_PORT: '', REPROPACK_SMTP_SECURE: '', REPROPACK_SMTP_USER: 'test-user', REPROPACK_SMTP_PASSWORD: 'test-only-password', REPROPACK_MAIL_FROM: 'sender@example.test' });
  assert.ok(defaultTransport); defaultTransport.close?.();
  assert.throws(() => mailFromEnvironment({ REPROPACK_SMTP_HOST: 'mail.example.test' }), /Configure SMTP/u);
  const commands: string[] = [];
  const smtp = createServer(socket => {
    socket.write('220 localhost ESMTP\r\n'); let pending = '';
    socket.on('data', chunk => {
      pending += chunk.toString();
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n'), line = pending.slice(0, end); pending = pending.slice(end + 2); commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (line === 'STARTTLS') { socket.end('454 TLS unavailable\r\n'); }
        else socket.end('500 Unexpected command\r\n');
      }
    });
  });
  smtp.listen(0, '127.0.0.1'); await once(smtp, 'listening'); const address = smtp.address(); assert(address && typeof address !== 'string');
  const mailer = mailFromEnvironment({ REPROPACK_SMTP_HOST: '127.0.0.1', REPROPACK_SMTP_PORT: String(address.port), REPROPACK_SMTP_USER: 'test-only-user', REPROPACK_SMTP_PASSWORD: 'test-only-smtp-password', REPROPACK_MAIL_FROM: 'repropack@example.test' })!;
  try {
    await assert.rejects(mailer.send({ to: 'owner@example.test', subject: 'Test', text: 'No credential should cross this plaintext connection.' }));
    assert.ok(commands.includes('STARTTLS')); assert.ok(!commands.some(line => line.startsWith('AUTH')));
  } finally { mailer.close?.(); await new Promise<void>((resolve, reject) => smtp.close(error => error ? reject(error) : resolve())); }
});
