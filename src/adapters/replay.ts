import { createDemoCart } from './demo-cart.ts';
import { matches } from '../core/model.ts';
import type { Capsule, Json, Step } from '../core/model.ts';
import type { Executor, TrialResult } from '../core/minimize.ts';

export function demoExecutor(capsule: Capsule, fixed = false): Executor {
  return async (steps, signal): Promise<TrialResult> => {
    signal.throwIfAborted();
    const fixture = await createDemoCart(fixed);
    try { return await replayHttp(capsule, steps, fixture.origin, signal); }
    finally { await fixture.dispose(); }
  };
}
export async function replayHttp(capsule: Capsule, steps: Step[], origin: string, signal: AbortSignal): Promise<TrialResult> {
    const url = new URL(origin);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || !url.port) throw new Error('Replay requires an assigned loopback HTTP origin');
    try {
      for (const step of steps) {
        signal.throwIfAborted();
        const options: RequestInit = {
          method: step.method, signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
          redirect: 'error', headers: { 'content-type': 'application/json' },
        };
        if (step.body !== undefined) options.body = JSON.stringify(step.body);
        const response = await fetch(new URL(step.path, origin), options);
        const observation = await response.json() as Json;
        if (step.id === capsule.oracle.stepId) {
          if (response.status !== capsule.oracle.status) return { verdict: 'unresolved', reason: `Oracle returned HTTP ${response.status}; expected ${capsule.oracle.status}.` };
          if (matches(observation, capsule.oracle.failure)) return { verdict: 'fail', reason: 'Exact original failure signature reproduced.', observation };
          if (matches(observation, capsule.oracle.success)) return { verdict: 'pass', reason: 'Expected success signature observed.', observation };
          return { verdict: 'unresolved', reason: 'Response matched neither the original failure nor the expected success.', observation };
        }
        if (step.expectStatus === undefined ? !response.ok : response.status !== step.expectStatus) return { verdict: 'unresolved', reason: `Setup step ${step.id} returned unexpected HTTP ${response.status}.` };
      }
      return { verdict: 'unresolved', reason: 'Oracle step was not executed.' };
    } catch (error) {
      signal.throwIfAborted();
      return { verdict: 'unresolved', reason: error instanceof Error ? error.message : 'Replay failed.' };
    }
}
