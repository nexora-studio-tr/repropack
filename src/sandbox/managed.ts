import type { TrialResult } from '../core/minimize.ts';
import type { DockerExecution } from './policy.ts';
import type { DockerCommand } from './docker.ts';
import { createArguments } from './policy.ts';
import { docker, inspectOwned, verifyRestrictions, DockerError, currentEngine } from './docker.ts';
import { createLease, removeOwned } from './leases.ts';

/** The lease exists before create: a daemon-side create/attach race remains recoverable. */
export async function managedTrial(execution: DockerExecution, input: string, directory: string, signal: AbortSignal, command: DockerCommand = docker, expectedEngine?: string): Promise<TrialResult> {
  if (Buffer.byteLength(input) > 4 * 1024 ** 2) throw new DockerError('Sandbox input exceeds 4 MiB');
  signal.throwIfAborted();
  const engineId = await currentEngine(command);
  if (expectedEngine && expectedEngine !== engineId) throw new DockerError('Docker engine changed after preflight; execution refused.');
  const lease = await createLease(directory, engineId); let removed = false;
  try {
    const id = (await command(createArguments(execution, lease.container, lease.owner, lease.scope))).trim();
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new DockerError('Docker did not return a container ID');
    const container = await inspectOwned(id, lease.owner, lease.scope, command);
    verifyRestrictions(container, execution);
    const deadline = AbortSignal.timeout(execution.quotas.wallMs);
    const combined = AbortSignal.any([signal, deadline]);
    let result: string;
    try { result = await command(['start', '--attach', '--interactive', id], { input, signal: combined, timeoutMs: execution.quotas.wallMs + 1000, maxBytes: 16_384 }); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      const state = (await inspectOwned(id, lease.owner, lease.scope, command)).State;
      if (state?.OOMKilled) return { verdict: 'unresolved', reason: 'Sandbox exceeded its memory quota. This is not the original failure.' };
      if (deadline.aborted) return { verdict: 'unresolved', reason: 'Sandbox exceeded its wall-clock quota. This is not the original failure.' };
      throw error;
    }
    const parsed = JSON.parse(result) as { verdict?: unknown };
    if (!['fail', 'pass', 'unresolved'].includes(parsed.verdict as string)) throw new DockerError('Invalid sandbox result');
    // Do not turn arbitrary stdout, observations or private payloads into a persisted report.
    return { verdict: parsed.verdict as TrialResult['verdict'], reason: parsed.verdict === 'fail' ? 'Exact original failure signature reproduced inside the sandbox.' : parsed.verdict === 'pass' ? 'Expected success signature observed inside the sandbox.' : 'Sandbox replay was inconclusive; a quota or different error is not the original failure.' };
  } finally {
    try { await removeOwned(lease.container, lease.owner, lease.scope, command, engineId); removed = true; }
    finally { await lease.close(removed); }
  }
}
