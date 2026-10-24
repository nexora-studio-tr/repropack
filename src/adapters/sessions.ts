import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Capsule } from '../core/model.ts';
import type { Executor } from '../core/minimize.ts';
import { InputError } from '../core/model.ts';
import { demoExecutor } from './replay.ts';
import { createCluster } from '../postgres/cluster.ts';
import { loadApplication } from '../postgres/config.ts';
import { prepareApplication } from '../postgres/environment.ts';
import { parseExecution } from '../sandbox/policy.ts';
import type { Quotas } from '../sandbox/policy.ts';

export interface AdapterEvidence {
  adapter: Capsule['adapter'];
  application?: string;
  snapshot?: string;
  snapshotSha256?: string;
  entryModuleSha256?: string;
  rowCounts?: Record<string, number>;
  totalRows?: number;
  redactedCells?: number;
  postgresVersion?: string;
  snapshotPostgresVersion?: string;
  execution?: { kind: 'trusted-native' } | { kind: 'docker'; image: string; engineId: string; network: 'none'; quotas: Quotas; recovered: number };
}
export interface AdapterSession { execute(fixed?: boolean): Executor; hasFix: boolean; evidence: AdapterEvidence; timeoutMs: number }
export async function createAdapterRegistry(directory: string, customConfig?: string, demoOnly = false) {
  const configurations = new Map<string, Awaited<ReturnType<typeof loadApplication>>>();
  if (!demoOnly) {
    const builtin = await loadApplication(fileURLToPath(new URL('../../examples/postgres-app/repropack.json', import.meta.url)));
    if (process.env.REPROPACK_SANDBOX_IMAGE) builtin.execution = parseExecution({ kind: 'docker', image: process.env.REPROPACK_SANDBOX_IMAGE, module: '/opt/repropack/examples/postgres-app/app.ts', fixedModule: '/opt/repropack/examples/postgres-app/fixed.ts' });
    configurations.set(builtin.id, builtin);
  }
  if (demoOnly && customConfig) throw new InputError('Custom applications are disabled in the public demo');
  if (customConfig) {
    const config = await loadApplication(customConfig);
    if (configurations.has(config.id)) throw new InputError('A custom application cannot replace a bundled application ID');
    configurations.set(config.id, config);
  }
  let clusterPromise: ReturnType<typeof createCluster> | undefined;
  const environments = new Map<string, ReturnType<typeof prepareApplication>>();
  function supports(capsule: Capsule) {
    if (capsule.adapter === 'demo-cart') return;
    const config = configurations.get(capsule.application ?? '');
    if (!config || config.snapshot.id !== capsule.snapshot) throw new InputError('Application/snapshot is not registered by the local operator');
  }
  return {
    supports,
    runtimeInfo: { applications: Object.fromEntries([...configurations].map(([id, config]) => [id, config.execution ? 'docker' : 'trusted-native'])) },
    async acquire(capsule: Capsule): Promise<AdapterSession> {
      supports(capsule);
      if (capsule.adapter === 'demo-cart') return { execute: (fixed = false) => demoExecutor(capsule, fixed), hasFix: true, evidence: { adapter: 'demo-cart' }, timeoutMs: 30_000 };
      const config = configurations.get(capsule.application!)!;
      if (!clusterPromise) clusterPromise = createCluster(join(directory, 'postgres')).catch(error => { clusterPromise = undefined; throw error; });
      let environment = environments.get(config.id);
      if (!environment) {
        environment = clusterPromise.then(cluster => prepareApplication(cluster, config)).catch(error => { environments.delete(config.id); throw error; });
        environments.set(config.id, environment);
      }
      const prepared = await environment;
      return { execute: (fixed = false) => prepared.executor(capsule, fixed), hasFix: prepared.hasFix, evidence: { adapter: 'node-http-postgres', ...prepared.evidence }, timeoutMs: config.execution ? 300_000 : 120_000 };
    },
    async close() {
      const results = await Promise.allSettled([...environments.values()]);
      try {
        const cleanups = await Promise.allSettled(results.filter(result => result.status === 'fulfilled').map(result => result.value.close()));
        const failed = cleanups.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally {
        if (clusterPromise) { const cluster = await clusterPromise.catch(() => undefined); await cluster?.close(); }
      }
    },
  };
}
