import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createCluster, client, databaseUrl, name, quote } from '../src/postgres/cluster.ts';
import type { Cluster } from '../src/postgres/cluster.ts';
import { loadApplication, parseSnapshot } from '../src/postgres/config.ts';
import { captureSnapshot, restoreSnapshot } from '../src/postgres/snapshot.ts';
import { prepareApplication } from '../src/postgres/environment.ts';
import { minimize } from '../src/core/minimize.ts';
import { parseCapsule } from '../src/core/model.ts';
import { reviveSnapshot } from '../src/sandbox/wire.ts';

let cluster: Cluster;
let environment: Awaited<ReturnType<typeof prepareApplication>>;
const configPath = fileURLToPath(new URL('../examples/postgres-app/repropack.json', import.meta.url));
const capsule = async () => parseCapsule(JSON.parse(await readFile(new URL('../examples/postgres-cart.json', import.meta.url), 'utf8')));
before(async () => {
  const parent = resolve('.repropack/test-postgres'); await mkdir(parent, { recursive: true });
  cluster = await createCluster(parent);
  environment = await prepareApplication(cluster, await loadApplication(configPath));
});
after(async () => { await environment?.close(); await cluster?.close(); });

async function database() {
  const id = name('test'); const admin = client(cluster.adminUrl); await admin.connect();
  await admin.query(`CREATE DATABASE ${quote(id)} TEMPLATE template0`);
  const connection = client(databaseUrl(cluster.adminUrl, id)); await connection.connect();
  return { connection, async close() { await connection.end(); await admin.query(`DROP DATABASE ${quote(id)} WITH (FORCE)`); await admin.end(); } };
}
test('native PostgreSQL snapshot excludes unrelated records and masks selected PII before restoring', () => {
  assert.match(cluster.version, /PostgreSQL 18\./u);
  assert.equal(environment.snapshot.totalRows, 4);
  assert.deepEqual(environment.snapshot.rowCounts, { 'public.cart_items': 1, 'public.carts': 1, 'public.customers': 1, 'public.products': 1 });
  assert.equal(environment.snapshot.redactedCells, 1);
  assert.match(environment.snapshot.rows['public.customers']![0]!.email as string, /^masked-[a-f0-9]{64}@example\.invalid$/u);
  assert.doesNotMatch(JSON.stringify(environment.snapshot), /alice@example\.test|bob@example\.test/u);
  assert.equal(environment.snapshot.rows['public.carts']![0]!.id, 42);
});
test('each actual application replay gets fresh database state and a fresh Node process', async () => {
  const input = await capsule(); const execute = environment.executor(input);
  for (let i = 0; i < 2; i++) assert.equal((await execute(input.steps, AbortSignal.timeout(20_000))).verdict, 'fail');
  assert.equal((await environment.executor(input, true)(input.steps, AbortSignal.timeout(20_000))).verdict, 'pass');
  const admin = client(cluster.adminUrl); await admin.connect();
  try { assert.equal((await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'rp_trial_%'")).rowCount, 0); assert.equal((await admin.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'rp_app_%'")).rowCount, 0); }
  finally { await admin.end(); }
});
test('the real PostgreSQL-backed application reduces its recorded flow and verifies the fixed module', { timeout: 120_000 }, async () => {
  const input = await capsule();
  const report = await minimize(input.steps, environment.executor(input), { anchorId: input.oracle.stepId, timeoutMs: 110_000 });
  assert.equal(report.status, 'completed', report.reason); assert.equal(report.finalVerified, true);
  assert.deepEqual(report.reducedStepIds, ['apply-coupon', 'change-quantity', 'checkout']);
  const reduced = input.steps.filter(step => report.reducedStepIds.includes(step.id));
  assert.equal((await environment.executor(input, true)(reduced, AbortSignal.timeout(20_000))).verdict, 'pass');
});
test('logical subsetting supports composite foreign keys and leaves the source unchanged', async () => {
  const source = await database(); const target = await database();
  const schema = 'CREATE TABLE public.parents(a integer,b integer,PRIMARY KEY(a,b)); CREATE TABLE public.children(id integer PRIMARY KEY,a integer,b integer,FOREIGN KEY(a,b) REFERENCES public.parents(a,b));';
  try {
    await source.connection.query(schema + 'INSERT INTO public.parents VALUES(1,2),(3,4); INSERT INTO public.children VALUES(10,1,2),(20,3,4);');
    const spec = parseSnapshot({ id: 'composite', tables: ['public.parents', 'public.children'], roots: [{ table: 'public.children', where: { id: 10 } }], maxRows: 5 });
    const snapshot = await captureSnapshot(source.connection, spec);
    assert.equal(snapshot.totalRows, 2); assert.deepEqual(snapshot.rows['public.parents'], [{ a: 1, b: 2 }]);
    assert.equal((await source.connection.query('SELECT * FROM public.children')).rowCount, 2);
    await target.connection.query(schema); await restoreSnapshot(target.connection, snapshot);
    assert.equal((await target.connection.query('SELECT * FROM public.children')).rowCount, 1);
  } finally { await source.close(); await target.close(); }
});
test('deferred FK cycles close transitively and restore without disabling constraints', async () => {
  const source = await database(); const target = await database();
  const schema = 'CREATE TABLE public.a(id integer PRIMARY KEY,b_id integer); CREATE TABLE public.b(id integer PRIMARY KEY,a_id integer REFERENCES public.a(id) DEFERRABLE); ALTER TABLE public.a ADD FOREIGN KEY(b_id) REFERENCES public.b(id) DEFERRABLE;';
  try {
    await source.connection.query(schema + 'BEGIN; SET CONSTRAINTS ALL DEFERRED; INSERT INTO public.a VALUES(1,2); INSERT INTO public.b VALUES(2,1); COMMIT;');
    const snapshot = await captureSnapshot(source.connection, parseSnapshot({ id: 'cycle', tables: ['public.a', 'public.b'], roots: [{ table: 'public.a', where: { id: 1 } }] }));
    assert.equal(snapshot.totalRows, 2);
    await target.connection.query(schema); await restoreSnapshot(target.connection, snapshot);
    assert.equal((await target.connection.query('SELECT * FROM public.a')).rowCount, 1);
    await assert.rejects(target.connection.query('INSERT INTO public.a VALUES(3,999)'), /foreign key/u);
  } finally { await source.close(); await target.close(); }
});
test('row budgets, missing parent allowlists, RLS and key redaction fail closed', async () => {
  const source = await database();
  try {
    await source.connection.query('CREATE TABLE public.p(id integer PRIMARY KEY,label text); CREATE TABLE public.c(id integer PRIMARY KEY,p_id integer REFERENCES public.p(id)); INSERT INTO public.p VALUES(1,\'secret\'); INSERT INTO public.c VALUES(2,1);');
    const base = { id: 'guarded', tables: ['public.p', 'public.c'], roots: [{ table: 'public.c', where: { id: 2 } }] };
    await assert.rejects(captureSnapshot(source.connection, parseSnapshot({ ...base, maxRows: 1 })), /budget/u);
    await assert.rejects(captureSnapshot(source.connection, parseSnapshot({ ...base, tables: ['public.c'] })), /allowlisting parent/u);
    await assert.rejects(captureSnapshot(source.connection, parseSnapshot({ ...base, redact: [{ table: 'public.p', column: 'id', kind: 'text' }] })), /non-key TEXT/u);
    await source.connection.query('ALTER TABLE public.p ENABLE ROW LEVEL SECURITY');
    await assert.rejects(captureSnapshot(source.connection, parseSnapshot(base)), /no RLS/u);
    assert.equal((await source.connection.query('SELECT * FROM public.c')).rowCount, 1);
  } finally { await source.close(); }
});
test('application configuration cannot escape its trusted directory or embed credentials in a capsule', async () => {
  const config = await loadApplication(configPath); assert.equal(config.id, 'postgres-cart');
  const original = await capsule();
  assert.throws(() => parseCapsule({ ...original, application: '../private-bot' }));
  assert.throws(() => parseCapsule({ ...original, databaseUrl: cluster.adminUrl }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(environment.executor(original)(original.steps, controller.signal));
});
test('application processes have no superuser, schema creation, other database access or inherited secret', async () => {
  const config = await loadApplication(configPath);
  config.module = fileURLToPath(new URL('./fixtures/process-check.ts', import.meta.url));
  config.moduleHash = createHash('sha256').update(await readFile(config.module)).digest('hex');
  const prepared = await prepareApplication(cluster, config);
  process.env.REPROPACK_TEST_SECRET = 'must-not-reach-child';
  try {
    const input = parseCapsule({ schemaVersion: 2, adapter: 'node-http-postgres', application: config.id, snapshot: config.snapshot.id, title: 'Process permissions', description: 'Actual child process privilege probe', steps: [{ id: 'check', method: 'GET', path: '/check' }], oracle: { stepId: 'check', status: 200, failure: { '/creationCount': 1, '/rolsuper': false, '/rolcreatedb': false, '/rolcreaterole': false, '/canCreateTable': false, '/canConnectOtherDatabase': false, '/inheritedSecret': false }, success: { '/creationCount': 2 } } });
    for (let i = 0; i < 2; i++) {
      const result = await prepared.executor(input)(input.steps, AbortSignal.timeout(20_000));
      assert.equal(result.verdict, 'fail', JSON.stringify(result));
    }
  } finally { delete process.env.REPROPACK_TEST_SECRET; await prepared.close(); }
});
test('cancellation during provisioning cleans every trial database and application role', async () => {
  const input = await capsule(); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try { await assert.rejects(environment.executor(input)(input.steps, controller.signal)); }
  finally { clearTimeout(timer); }
  const admin = client(cluster.adminUrl); await admin.connect();
  try {
    assert.equal((await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'rp_trial_%'")).rowCount, 0);
    assert.equal((await admin.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'rp_app_%'")).rowCount, 0);
  } finally { await admin.end(); }
});
test('snapshot restoration preserves large integer/decimal values, bytea, JSON and identity progress', async () => {
  const source = await database(); const target = await database();
  const schema = 'CREATE TABLE public.precise(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,amount numeric(30,8),data bytea,meta jsonb);';
  try {
    await source.connection.query(schema);
    const meta = { nested: true, encoded: { type: 'Buffer', data: [0, 128, 255] } };
    await source.connection.query('INSERT INTO public.precise(id,amount,data,meta) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4)', ['9007199254740993', '123456789.12345678', Buffer.from([0, 128, 255]), meta]);
    const snapshot = await captureSnapshot(source.connection, parseSnapshot({ id: 'precision', tables: ['public.precise'], roots: [{ table: 'public.precise', where: { id: '9007199254740993' } }] }));
    await target.connection.query(schema); await restoreSnapshot(target.connection, reviveSnapshot(JSON.parse(JSON.stringify(snapshot))));
    const copied = (await target.connection.query('SELECT * FROM public.precise')).rows[0];
    assert.equal(copied.id, '9007199254740993'); assert.equal(copied.amount, '123456789.12345678'); assert.deepEqual(copied.data, Buffer.from([0, 128, 255])); assert.deepEqual(copied.meta, meta);
    assert.equal((await target.connection.query('INSERT INTO public.precise DEFAULT VALUES RETURNING id')).rows[0].id, '9007199254740994');
  } finally { await source.close(); await target.close(); }
});
test('an explicitly selected source database is read only and remains untouched after environment cleanup', async () => {
  const source = await database(); const config = await loadApplication(configPath);
  let prepared: Awaited<ReturnType<typeof prepareApplication>> | undefined;
  const previous = process.env.REPROPACK_TEST_SOURCE_URL;
  try {
    await source.connection.query(config.schema); await source.connection.query(config.seed!);
    const before = (await source.connection.query('SELECT * FROM public.customers ORDER BY id')).rows;
    process.env.REPROPACK_TEST_SOURCE_URL = databaseUrl(cluster.adminUrl, (await source.connection.query('SELECT current_database() AS db')).rows[0].db);
    config.sourceUrlEnv = 'REPROPACK_TEST_SOURCE_URL'; delete config.seed;
    prepared = await prepareApplication(cluster, config);
    assert.equal(prepared.snapshot.totalRows, 4); await prepared.close(); prepared = undefined;
    assert.deepEqual((await source.connection.query('SELECT * FROM public.customers ORDER BY id')).rows, before);
    assert.equal((await source.connection.query('SELECT * FROM public.carts')).rowCount, 2);
  } finally {
    if (previous === undefined) delete process.env.REPROPACK_TEST_SOURCE_URL; else process.env.REPROPACK_TEST_SOURCE_URL = previous;
    await prepared?.close(); await source.close();
  }
});

test('snapshot allowlists cannot expand through inherited children or partition leaves', async () => {
  const source = await database();
  try {
    await source.connection.query('CREATE TABLE public.parent(id int PRIMARY KEY); CREATE TABLE public.hidden() INHERITS(public.parent); INSERT INTO public.hidden VALUES(1); CREATE TABLE public.events(id int PRIMARY KEY) PARTITION BY RANGE(id); CREATE TABLE public.events_child PARTITION OF public.events FOR VALUES FROM(0) TO(100); INSERT INTO public.events VALUES(1)');
    for (const table of ['public.parent', 'public.hidden', 'public.events_child']) await assert.rejects(captureSnapshot(source.connection, parseSnapshot({ id: 'inheritance', tables: [table], roots: [{ table, where: { id: 1 } }] })), /inheritance/u);
    assert.equal((await source.connection.query('SELECT * FROM public.hidden')).rowCount, 1);
  } finally { await source.close(); }
});
