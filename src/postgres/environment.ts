import { randomBytes } from 'node:crypto';
import { client, databaseUrl, quote, name } from './cluster.ts';
import type { Cluster } from './cluster.ts';
import type { ApplicationConfig } from './config.ts';
import { captureSnapshot, restoreSnapshot } from './snapshot.ts';
import { launchApplication } from './application.ts';
import { replayHttp } from '../adapters/replay.ts';
import type { Capsule } from '../core/model.ts';
import type { Executor } from '../core/minimize.ts';
import { join } from 'node:path';
import { createSandbox } from '../sandbox/host.ts';

export async function prepareApplication(cluster: Cluster, config: ApplicationConfig) {
  // Infrastructure must pass before importing any workload or copying a source snapshot.
  const sandbox = config.execution ? await createSandbox(config.execution, join(cluster.directory, '..', '..', 'sandbox-leases')) : undefined;
  const admin = client(cluster.adminUrl); await admin.connect();
  const databases = new Set<string>(); const roles = new Set<string>();
  const owner = name('owner');
  const ownerPassword = randomBytes(24).toString('hex');
  const snapshotDatabase = name('snapshot');
  let closed = false;
  async function dropDatabase(database: string) {
    if (!databases.has(database)) throw new Error('Refusing to drop an unowned database');
    await admin.query(`DROP DATABASE ${quote(database)} WITH (FORCE)`); databases.delete(database);
  }
  async function createDatabase(database: string, template = 'template0') {
    await admin.query(`CREATE DATABASE ${quote(database)} TEMPLATE ${quote(template)} OWNER ${quote(owner)}`); databases.add(database);
    await admin.query(`REVOKE ALL ON DATABASE ${quote(database)} FROM PUBLIC`);
  }
  async function role(roleName: string, password?: string) {
    await admin.query(`CREATE ROLE ${quote(roleName)} ${password ? `LOGIN PASSWORD '${password}'` : 'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`); roles.add(roleName);
  }
  async function close() {
    if (closed) return; closed = true;
    try {
      for (const database of [...databases].reverse()) await dropDatabase(database);
      for (const role of roles) await admin.query(`DROP ROLE ${quote(role)}`);
    } finally { await admin.end(); }
  }
  try {
    await role(owner, ownerPassword);
    let sourceUrl: string;
    let ownedSource: string | undefined;
    if (config.sourceUrlEnv) {
      const configured = process.env[config.sourceUrlEnv];
      if (!configured || !/^postgres(?:ql)?:\/\//u.test(configured)) throw new Error(`Set ${config.sourceUrlEnv} to your explicitly selected source database URL`);
      sourceUrl = configured;
    } else {
      ownedSource = name('source'); await createDatabase(ownedSource);
      sourceUrl = databaseUrl(cluster.adminUrl, ownedSource, owner, ownerPassword);
      const seed = client(sourceUrl); await seed.connect();
      try { await seed.query(config.schema); if (config.seed) await seed.query(config.seed); }
      finally { await seed.end(); }
    }
    const source = client(sourceUrl); await source.connect();
    const snapshot = await captureSnapshot(source, config.snapshot).finally(() => source.end());
    await createDatabase(snapshotDatabase);
    const target = client(databaseUrl(cluster.adminUrl, snapshotDatabase, owner, ownerPassword)); await target.connect();
    try { await target.query(config.schema); await restoreSnapshot(target, snapshot); }
    finally { await target.end(); }
    await admin.query(`ALTER DATABASE ${quote(snapshotDatabase)} ALLOW_CONNECTIONS false`);
    if (ownedSource) await dropDatabase(ownedSource);
    const evidence = { application: config.id, snapshot: snapshot.id, snapshotSha256: snapshot.sha256, entryModuleSha256: config.moduleHash, rowCounts: snapshot.rowCounts, totalRows: snapshot.totalRows, redactedCells: snapshot.redactedCells, ...(sandbox ? { snapshotPostgresVersion: cluster.version } : { postgresVersion: cluster.version }), execution: sandbox?.evidence ?? { kind: 'trusted-native' as const } };
    function executor(capsule: Capsule, fixed = false): Executor {
      if (capsule.adapter !== 'node-http-postgres' || capsule.application !== config.id || capsule.snapshot !== config.snapshot.id) throw new Error('Capsule does not match the explicitly configured application/snapshot');
      if (fixed && !config.fixedModule) throw new Error('No fixedModule is configured');
      return async (steps, signal) => {
        signal.throwIfAborted();
        if (sandbox && config.execution) return await sandbox.execute({ capsule, steps, snapshot, schema: config.schema, module: fixed ? config.execution.fixedModule! : config.execution.module, moduleHash: fixed ? config.fixedModuleHash! : config.moduleHash }, signal);
        const database = name('trial'); const login = name('app'); const password = randomBytes(24).toString('hex');
        let application: Awaited<ReturnType<typeof launchApplication>> | undefined;
        try {
          await role(login, password); await createDatabase(database, snapshotDatabase);
          signal.throwIfAborted();
          await admin.query(`GRANT CONNECT ON DATABASE ${quote(database)} TO ${quote(login)}`);
          const setup = client(databaseUrl(cluster.adminUrl, database)); await setup.connect();
          try {
            for (const schema of new Set(config.snapshot.tables.map(table => table.split('.')[0]!))) {
              await setup.query(`REVOKE ALL ON SCHEMA ${quote(schema)} FROM PUBLIC; GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(login)}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quote(schema)} TO ${quote(login)}; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quote(schema)} TO ${quote(login)}`);
            }
          } finally { await setup.end(); }
          const module = fixed ? config.fixedModule! : config.module;
          application = await launchApplication(module, databaseUrl(cluster.adminUrl, database, login, password), signal, fixed ? config.fixedModuleHash : config.moduleHash);
          return await replayHttp(capsule, steps, application.origin, signal);
        } finally {
          await application?.close();
          if (databases.has(database)) await dropDatabase(database);
          if (roles.has(login)) { await admin.query(`DROP ROLE ${quote(login)}`); roles.delete(login); }
        }
      };
    }
    return { snapshot, evidence, executor, close, hasFix: Boolean(config.fixedModule) };
  } catch (error) { await close(); throw error; }
}
