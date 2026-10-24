import { guardian } from '../runtime/guardian.ts';
import type { DockerExecution } from './policy.ts';
import type { Snapshot } from '../postgres/snapshot.ts';
import type { Capsule, Step } from '../core/model.ts';
import type { TrialResult } from '../core/minimize.ts';
import { preflight } from './docker.ts';
import { recoverLeases } from './leases.ts';

export interface TrialInput { capsule: Capsule; steps: Step[]; snapshot: Snapshot; schema: string; module: string; moduleHash: string }
export async function createSandbox(execution: DockerExecution, directory: string) {
  const evidence = await preflight(execution);
  const recovered = await recoverLeases(directory);
  return { evidence: { ...evidence, recovered }, async execute(input: TrialInput, signal: AbortSignal): Promise<TrialResult> {
    signal.throwIfAborted();
    const { child, exited, send } = guardian(new URL('./guardian.ts', import.meta.url), ['HOME', 'USERPROFILE', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']);
    const abort = () => send({ type: 'cancel' });
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await new Promise<TrialResult>((resolve, reject) => {
        let settled = false;
        child.on('message', (raw: unknown) => {
          const value = raw as { type: string; result?: TrialResult; message?: string };
          if (value.type === 'result' && value.result) { settled = true; resolve(value.result); }
          if (value.type === 'error') { settled = true; reject(new Error(value.message)); }
        });
        child.on('exit', () => { if (!settled) reject(new Error('Sandbox supervisor exited unexpectedly; inspect recovery journals before retrying.')); });
        child.on('error', reject);
        send({ type: 'start', execution, directory, engineId: evidence.engineId, input: JSON.stringify(input) });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      return result;
    } finally { signal.removeEventListener('abort', abort); await exited; }
  } };
}
