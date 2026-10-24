import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, example } from '../src/server.ts';
import { Store } from '../src/store.ts';
import type { Run } from '../src/store.ts';
import { Client, testBootstrap, localHeaders } from './fixtures/identity.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'repropack-test-'));
  const key = testBootstrap(); const app = await createApp(directory, { bootstrapToken: key });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const client = new Client(origin); await client.setup(key);
  return { ...app, origin, client, async close() { await app.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
async function finished(client: Client, id: string): Promise<Run> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await client.request(`/api/runs/${id}`); const run = await response.json() as Run;
    if (run.status !== 'queued' && run.status !== 'running') return run;
    await delay(25);
  }
  throw new Error('Run did not finish');
}
test('HTTP API persists a run, exports replayable evidence and verifies only the included demo fix', async () => {
  const app = await fixture();
  try {
    const capsule = await example();
    const started = await app.client.request('/api/runs', { capsule });
    assert.equal(started.status, 202); const { id } = await started.json() as { id: string };
    const run = await finished(app.client, id); assert.equal(run.status, 'completed'); assert.equal(run.report?.reducedSteps, 5);
    const exported = await app.client.request(`/api/runs/${id}/capsule`); assert.equal(exported.status, 200);
    assert.equal((await exported.json() as { steps: unknown[] }).steps.length, 5);
    const verification = await app.client.request(`/api/runs/${id}/verify`, {});
    assert.equal(verification.status, 200); assert.equal((await verification.json() as { passed: boolean }).passed, true);
    const report = await app.client.request(`/api/runs/${id}/report`); assert.equal(report.status, 200);
    assert.match(report.headers.get('content-disposition') ?? '', /attachment/u);
    assert.equal((await report.json() as { verification: { adapter: string } }).verification.adapter, 'demo-cart-fixed');
    const history = await app.client.request('/api/runs'); assert.equal((await history.json() as unknown[]).length, 1);
  } finally { await app.close(); }
});
test('same-origin writes are required; invalid requests cannot create work', async () => {
  const app = await fixture();
  try {
    const capsule = await example();
    const headers = (origin: string) => ({ ...localHeaders(origin), cookie: app.client.cookie, 'x-repropack-csrf': app.client.csrf });
    assert.equal((await fetch(`${app.origin}/api/runs`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${app.origin}/api/runs`, { method: 'POST', headers: headers('https://evil.example'), body: JSON.stringify({ capsule }) })).status, 403);
    assert.equal((await fetch(`${app.origin}/api/runs`, { method: 'POST', headers: headers(app.origin), body: '{' })).status, 400);
    assert.equal((await fetch(`${app.origin}/api/runs`, { method: 'POST', headers: headers(app.origin), body: JSON.stringify({ capsule: { ...capsule, adapter: 'production' } }) })).status, 400);
    assert.equal((await fetch(`${app.origin}/api/runs`, { method: 'POST', headers: headers(app.origin), body: JSON.stringify({ capsule, maxTrials: 10000 }) })).status, 400);
    assert.equal((await fetch(`${app.origin}/api/runs`, { method: 'POST', headers: headers(app.origin), body: JSON.stringify({ capsule: { ...capsule, schemaVersion: 2, adapter: 'node-http-postgres', application: 'unregistered-app', snapshot: 'case' } }) })).status, 400);
    assert.equal((await fetch(`${app.origin}/api/runs`, { method: 'POST', headers: headers(app.origin), body: JSON.stringify({ capsule: { reviewState: 'pending', formatVersion: 1, capsule } }) })).status, 400);
    assert.equal((await fetch(`${app.origin}/api/runs`, { method: 'PUT' })).status, 405);
    const history = await app.client.request('/api/runs'); assert.deepEqual(await history.json(), []);
  } finally { await app.close(); }
});
test('host validation blocks DNS rebinding and responses prevent framing', async () => {
  const app = await fixture();
  try {
    const response = await app.client.request('/api/example');
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${app.origin}/api/example`, { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
  } finally { await app.close(); }
});
test('budget-exhausted runs cannot export an apparently verified capsule', async () => {
  const app = await fixture();
  try {
    const response = await app.client.request('/api/runs', { capsule: await example(), maxTrials: 6 });
    const { id } = await response.json() as { id: string }; const run = await finished(app.client, id);
    assert.equal(run.status, 'budget_exhausted');
    assert.equal((await app.client.request(`/api/runs/${id}/capsule`)).status, 409);
    assert.equal((await app.client.request(`/api/runs/${id}/verify`, {})).status, 409);
  } finally { await app.close(); }
});
test('server restart marks unfinished work interrupted instead of silently replaying it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repropack-recovery-'));
  const store = new Store(directory);
  store.save({ id: 'interrupted-run', teamId: 'test-team', createdBy: 'test-actor', createdAt: new Date().toISOString(), status: 'running', source: await example(), events: [] }); store.close();
  const recovered = new Store(directory);
  try { assert.equal(recovered.get('interrupted-run', 'test-team')?.status, 'interrupted'); assert.equal(recovered.get('interrupted-run', 'test-team')?.events.length, 0); }
  finally { recovered.close(); await rm(directory, { recursive: true, force: true }); }
});
