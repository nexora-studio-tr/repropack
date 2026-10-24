import { guardian } from '../runtime/guardian.ts';
export { client, databaseUrl, qualified, quote, name } from './cluster-native.ts';
export type { Cluster } from './cluster-native.ts';
import type { Cluster } from './cluster-native.ts';

export async function createCluster(parent: string): Promise<Cluster> {
  const { child, exited, send } = guardian(new URL('./cluster-guardian.ts', import.meta.url));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { send({ type: 'close' }); await exited; if (child.exitCode !== 0) throw new Error('PostgreSQL supervisor cleanup failed; owned data was retained for inspection.'); })();
  try {
    const result = await new Promise<Omit<Cluster, 'close'>>((resolve, reject) => {
      const timer = setTimeout(() => { clean(); reject(new Error('PostgreSQL supervisor startup exceeded 50 seconds')); }, 50_000);
      const clean = () => { clearTimeout(timer); child.off('message', message); child.off('error', failError); child.off('exit', fail); };
      const fail = () => { clean(); reject(new Error('PostgreSQL supervisor exited before becoming ready')); };
      const failError = (error: Error) => { clean(); reject(error); };
      const message = (raw: unknown) => {
        const value = raw as { type: string; cluster: Omit<Cluster, 'close'>; message?: string };
        if (value.type === 'ready') { clean(); resolve(value.cluster); }
        if (value.type === 'error') { clean(); reject(new Error(value.message ?? 'Native PostgreSQL startup failed')); }
      };
      child.on('message', message); child.once('error', failError); child.once('exit', fail);
      send({ type: 'init', parent });
    });
    return { ...result, close };
  } catch (error) { await close(); throw error; }
}
