import type { Json, Step } from './model.ts';

export type Verdict = 'fail' | 'pass' | 'unresolved';
export interface TrialResult { verdict: Verdict; reason: string; observation?: Json }
export interface TrialEvent { trial: number; phase: string; stepIds: string[]; verdict: Verdict; reason: string; durationMs: number; omittedStepId?: string }
export interface DeletionWitness {
  stepId: string;
  status: 'anchor' | 'necessary' | 'unresolved' | 'removable' | 'unchecked';
  trialNumbers: number[];
  outcomes: Verdict[];
}
export interface Reduction {
  status: 'completed' | 'budget_exhausted' | 'inconclusive' | 'cancelled';
  reason: string;
  originalStepIds: string[];
  reducedStepIds: string[];
  originalSteps: number;
  reducedSteps: number;
  trials: number;
  cacheHits: number;
  durationMs: number;
  baselineVerified: boolean;
  finalVerified: boolean;
  oneMinimal: boolean;
  unresolvedDeletions: number;
  limits: { maxTrials: number; timeoutMs: number };
  events: TrialEvent[];
  /** Optional for stored evidence from earlier releases. New reductions always include it. */
  deletionWitnesses?: DeletionWitness[];
}
export interface Options {
  anchorId: string;
  maxTrials?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: TrialEvent) => void;
}
export type Executor = (steps: Step[], signal: AbortSignal) => Promise<TrialResult>;
class BudgetStop extends Error {}

/** Complement-based delta debugging. Order is preserved; exact failure signatures belong to the executor. */
export async function minimize(steps: Step[], execute: Executor, options: Options): Promise<Reduction> {
  const maxTrials = options.maxTrials ?? 160;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(maxTrials) || maxTrials < 3 || maxTrials > 2000 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error('Invalid reduction budget');
  if (!steps.some(step => step.id === options.anchorId) || new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('A unique anchored step is required');
  const started = performance.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const cache = new Map<string, Verdict>();
  let current = [...steps];
  let trials = 0, cacheHits = 0, baselineVerified = false, finalVerified = false, oneMinimal = false, unresolvedDeletions = 0;
  const events: TrialEvent[] = [];
  const witnesses = new Map<string, DeletionWitness>();
  let checking: string | undefined;
  const guard = () => {
    if (options.signal?.aborted) throw options.signal.reason;
    if (deadline.aborted || trials >= maxTrials) throw new BudgetStop('Trial or time budget exhausted');
  };
  const trial = async (candidate: Step[], phase: string): Promise<Verdict> => {
    guard();
    const start = performance.now();
    const result = await execute(candidate, signal);
    trials++;
    const event: TrialEvent = { trial: trials, phase, stepIds: candidate.map(step => step.id), verdict: result.verdict, reason: result.reason, durationMs: Math.round(performance.now() - start), ...(phase === 'minimality' && checking !== undefined ? { omittedStepId: checking } : {}) };
    events.push(event);
    if (event.omittedStepId !== undefined) {
      const witness = witnesses.get(event.omittedStepId)!;
      witness.trialNumbers.push(event.trial); witness.outcomes.push(event.verdict);
    }
    options.onEvent?.(event);
    if (options.signal?.aborted) throw options.signal.reason;
    if (deadline.aborted) throw new BudgetStop('Time budget exhausted');
    return result.verdict;
  };
  const repeated = async (candidate: Step[], phase: string, count = 2): Promise<Verdict> => {
    const results: Verdict[] = [];
    for (let i = 0; i < count; i++) results.push(await trial(candidate, phase));
    return results.every(value => value === results[0]) ? results[0]! : 'unresolved';
  };
  const evaluate = async (candidate: Step[]): Promise<Verdict> => {
    const key = JSON.stringify(candidate.map(step => step.id));
    const previous = cache.get(key);
    if (previous) { cacheHits++; return previous; }
    const result = await repeated(candidate, 'reduce');
    // Uncertain outcomes may be transient. Never cache them as successful reductions.
    if (result !== 'unresolved') cache.set(key, result);
    return result;
  };
  const report = (status: Reduction['status'], reason: string): Reduction => ({
    status, reason, originalStepIds: steps.map(step => step.id), reducedStepIds: current.map(step => step.id),
    originalSteps: steps.length, reducedSteps: current.length, trials, cacheHits,
    durationMs: Math.round(performance.now() - started), baselineVerified, finalVerified,
    oneMinimal, unresolvedDeletions, limits: { maxTrials, timeoutMs }, events,
    deletionWitnesses: current.map(step => {
      const witness = witnesses.get(step.id);
      return witness ? { ...witness, trialNumbers: [...witness.trialNumbers], outcomes: [...witness.outcomes] }
        : { stepId: step.id, status: step.id === options.anchorId ? 'anchor' : 'unchecked', trialNumbers: [], outcomes: [] };
    }),
  });
  try {
    if (await repeated(current, 'baseline', 3) !== 'fail') return report('inconclusive', 'The baseline did not reproduce the exact failure in all three trials.');
    baselineVerified = true;
    let partitions = 2;
    while (current.length > 1) {
      const size = Math.ceil(current.length / partitions);
      let changed = false;
      for (let index = 0; index < current.length; index += size) {
        const candidate = [...current.slice(0, index), ...current.slice(index + size)];
        if (!candidate.some(step => step.id === options.anchorId)) continue;
        if (await evaluate(candidate) === 'fail') {
          current = candidate;
          partitions = Math.max(2, partitions - 1);
          changed = true;
          break;
        }
      }
      if (changed) continue;
      if (partitions >= current.length) break;
      partitions = Math.min(current.length, partitions * 2);
    }
    // Fresh trials prevent stale cached failures from being presented as final evidence.
    if (await repeated(current, 'verify', 3) !== 'fail') return report('inconclusive', 'The reduced scenario was unstable during fresh verification.');
    finalVerified = true;
    // Certification is deliberately stricter than reduction: unresolved deletions are not proofs of necessity.
    for (const step of current) {
      if (step.id === options.anchorId) continue;
      checking = step.id;
      const witness: DeletionWitness = { stepId: step.id, status: 'unchecked', trialNumbers: [], outcomes: [] };
      witnesses.set(step.id, witness);
      const verdict = await repeated(current.filter(item => item.id !== step.id), 'minimality');
      witness.status = verdict === 'pass' ? 'necessary' : verdict === 'fail' ? 'removable' : 'unresolved';
      if (verdict === 'fail') return report('inconclusive', 'A fresh deletion reproduced the failure; the oracle changed during reduction.');
      if (verdict === 'unresolved') unresolvedDeletions++;
    }
    oneMinimal = unresolvedDeletions === 0;
    return report('completed', oneMinimal
      ? 'Failure preserved. Every permitted single-step deletion was checked; this is anchored 1-minimal, not necessarily globally smallest.'
      : 'Failure preserved. Some deletions made the replay invalid or uncertain, so minimality is not certified.');
  } catch (error) {
    if (options.signal?.aborted) return report('cancelled', 'Cancelled by the user. Partial output is not certified.');
    if (error instanceof BudgetStop || deadline.aborted) return report('budget_exhausted', 'Budget exhausted. Best observed candidate retained; certification may be incomplete.');
    throw error;
  }
}
