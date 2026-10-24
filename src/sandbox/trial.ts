import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createNativeCluster, client, databaseUrl, quote } from '../postgres/cluster-native.ts';
import { restoreSnapshot } from '../postgres/snapshot.ts';
import { launchApplication } from '../postgres/application.ts';
import { parseCapsule } from '../core/model.ts';
import { replayHttp } from '../adapters/replay.ts';
import type { TrialInput } from './host.ts';
import { reviveSnapshot } from './wire.ts';

// Only this disposable container sees the selected masked snapshot and temporary DB credentials.
async function main() {
  if (process.platform !== 'linux' || process.env.REPROPACK_IN_SANDBOX !== '1' || await readFile('/opt/repropack/.sandbox-runtime', 'utf8') !== 'repropack-v1\n') throw new Error('Use the sandbox runtime image');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += (chunk as Buffer).length; if (size > 4 * 1024 ** 2) throw new Error('Oversized input'); chunks.push(chunk as Buffer); }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as TrialInput;
  input.snapshot = reviveSnapshot(input.snapshot);
  const capsule = parseCapsule({ ...input.capsule, steps: input.steps });
  const cluster = await createNativeCluster('/work/postgres');
  let application: Awaited<ReturnType<typeof launchApplication>> | undefined;
  try {
    const admin = client(cluster.adminUrl); await admin.connect();
    const ownerPassword = randomBytes(24).toString('hex'); const password = randomBytes(24).toString('hex');
    try {
      await admin.query(`CREATE ROLE rp_owner LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE; CREATE ROLE rp_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      await admin.query('CREATE DATABASE rp_trial TEMPLATE template0 OWNER rp_owner');
      await admin.query('REVOKE ALL ON DATABASE rp_trial FROM PUBLIC; GRANT CONNECT ON DATABASE rp_trial TO rp_app');
      const target = client(databaseUrl(cluster.adminUrl, 'rp_trial', 'rp_owner', ownerPassword)); await target.connect();
      try {
        await target.query(input.schema); await restoreSnapshot(target, input.snapshot);
        for (const schema of new Set(input.snapshot.tables.map(table => table.name.split('.')[0]!))) await target.query(`REVOKE ALL ON SCHEMA ${quote(schema)} FROM PUBLIC; GRANT USAGE ON SCHEMA ${quote(schema)} TO rp_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quote(schema)} TO rp_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quote(schema)} TO rp_app`);
      } finally { await target.end(); }
    } finally { await admin.end(); }
    const signal = AbortSignal.timeout(25_000);
    application = await launchApplication(input.module, databaseUrl(cluster.adminUrl, 'rp_trial', 'rp_app', password), signal, input.moduleHash);
    const result = await replayHttp(capsule, capsule.steps, application.origin, signal);
    // Intentionally omit observations and untrusted error messages from the output protocol.
    process.stdout.write(JSON.stringify({ verdict: result.verdict }));
  } finally { try { await application?.close(); } finally { await cluster.close(); } }
}
main().catch(() => { process.stdout.write(JSON.stringify({ verdict: 'unresolved' })); process.exitCode = 1; });
