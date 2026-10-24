import { managedTrial } from './managed.ts';
import { parseExecution } from './policy.ts';
import { docker } from './docker.ts';

const controller = new AbortController();
let work: Promise<void> | undefined;
process.on('disconnect', () => controller.abort(new Error('Workbench disconnected')));
process.on('message', (raw: unknown) => {
  const value = raw as { type?: string; execution?: unknown; input?: string; directory?: string; engineId?: string };
  if (value.type === 'cancel') { controller.abort(new Error('Sandbox cancelled')); return; }
  if (value.type !== 'start' || work || typeof value.input !== 'string' || typeof value.directory !== 'string' || typeof value.engineId !== 'string') return;
  work = (async () => {
    try {
      const result = await managedTrial(parseExecution(value.execution), value.input!, value.directory!, controller.signal, docker, value.engineId!);
      if (process.connected) process.send?.({ type: 'result', result });
    } catch {
      if (process.connected) process.send?.({ type: 'error', message: 'Sandbox execution or cleanup failed. No native fallback was used; recovery journal is retained when needed.' });
    } finally { if (process.connected) process.disconnect(); }
  })();
});
