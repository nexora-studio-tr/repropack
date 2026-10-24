import { createNativeCluster } from './cluster-native.ts';
import type { Cluster } from './cluster-native.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let cluster: Cluster | undefined;
let starting: Promise<void> | undefined;
let closing = false;
async function close() {
  if (closing) return; closing = true;
  try { await starting; await cluster?.close(); process.exitCode = 0; }
  catch (error) {
    process.exitCode = 1;
    if (cluster) await writeFile(join(cluster.directory, '.repropack-cleanup-error'), error instanceof Error ? error.message : 'Owned cluster cleanup failed', { mode: 0o600 }).catch(() => undefined);
  }
  finally { if (process.connected) process.disconnect(); }
}
process.on('disconnect', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
process.on('message', (raw: unknown) => {
  const input = raw as { type?: string; parent?: string };
  if (input.type === 'close') { void close(); return; }
  if (input.type !== 'init' || starting || closing || typeof input.parent !== 'string') return;
  starting = (async () => {
    try {
      cluster = await createNativeCluster(input.parent!);
      if (!closing && process.connected) process.send?.({ type: 'ready', cluster: { adminUrl: cluster.adminUrl, version: cluster.version, directory: cluster.directory } });
    } catch (error) {
      if (process.connected) process.send?.({ type: 'error', message: error instanceof Error ? error.message : 'PostgreSQL startup failed' });
      setImmediate(() => { void close(); });
    }
  })();
});
