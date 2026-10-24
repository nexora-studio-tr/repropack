import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { minimize } from '../src/core/minimize.ts';
import type { Executor } from '../src/core/minimize.ts';
import { matches, parseCapsule, InputError } from '../src/core/model.ts';
import type { Step } from '../src/core/model.ts';
import { example } from '../src/server.ts';
import { demoExecutor } from '../src/adapters/replay.ts';

const sequence = (ids: string[]): Step[] => ids.map(id => ({ id, method: 'GET', path: '/health' }));
const executor: Executor = async steps => ({ verdict: ['a', 'c', 'oracle'].every(id => steps.some(step => step.id === id)) ? 'fail' : 'pass', reason: 'Known deterministic test oracle' });

test('reduces an ordered sequence, preserves its anchor and verifies 1-minimality with fresh trials', async () => {
  const steps = sequence(['noise-1', 'a', 'noise-2', 'c', 'noise-3', 'oracle']);
  const report = await minimize(steps, async (candidate, signal) => {
    assert.deepEqual(candidate, steps.filter(step => candidate.some(item => item.id === step.id)));
    return executor(candidate, signal);
  }, { anchorId: 'oracle' });
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.reducedStepIds, ['a', 'c', 'oracle']);
  assert.equal(report.oneMinimal, true);
  assert.equal(report.finalVerified, true);
  assert.equal(report.events.filter(event => event.phase === 'baseline').length, 3);
  assert.equal(report.events.filter(event => event.phase === 'verify').length, 3);
});
test('unknown deletion results never certify minimality or count as a successful reduction', async () => {
  const report = await minimize(sequence(['a', 'c', 'oracle']), async steps => ({ verdict: steps.length === 3 ? 'fail' : 'unresolved', reason: 'Setup missing' }), { anchorId: 'oracle' });
  assert.equal(report.status, 'completed'); assert.equal(report.finalVerified, true);
  assert.equal(report.oneMinimal, false); assert.equal(report.unresolvedDeletions, 2);
  assert.equal(report.reducedSteps, 3);
});
test('a passing or unstable baseline cannot produce a certified capsule', async () => {
  for (const verdicts of [['pass', 'pass', 'pass'], ['fail', 'fail', 'pass']] as const) {
    let index = 0;
    const report = await minimize(sequence(['a', 'oracle']), async () => ({ verdict: verdicts[index++]!, reason: 'Baseline check' }), { anchorId: 'oracle' });
    assert.equal(report.status, 'inconclusive'); assert.equal(report.baselineVerified, false); assert.equal(report.finalVerified, false);
  }
});
test('cached reductions are rechecked and late oracle instability is exposed', async () => {
  let shortTrials = 0;
  const report = await minimize(sequence(['noise', 'oracle']), async steps => ({ verdict: steps.length === 2 || ++shortTrials <= 2 ? 'fail' : 'pass', reason: 'Late instability' }), { anchorId: 'oracle' });
  assert.equal(report.status, 'inconclusive'); assert.equal(report.finalVerified, false); assert.equal(report.oneMinimal, false);
});
test('trial exhaustion preserves the best observed candidate without false certification', async () => {
  const report = await minimize(sequence(['a', 'c', 'oracle']), executor, { anchorId: 'oracle', maxTrials: 3 });
  assert.equal(report.status, 'budget_exhausted'); assert.equal(report.trials, 3);
  assert.equal(report.finalVerified, false); assert.equal(report.oneMinimal, false);
});
test('cancellation before a run executes no trials', async () => {
  const controller = new AbortController(); controller.abort();
  const report = await minimize(sequence(['a', 'oracle']), async () => { throw new Error('Must not execute'); }, { anchorId: 'oracle', signal: controller.signal });
  assert.equal(report.status, 'cancelled'); assert.equal(report.trials, 0);
});
test('the replay deadline stops an in-flight cooperative executor', async () => {
  const report = await minimize(sequence(['a', 'oracle']), async (_steps, signal) => { await delay(500, undefined, { signal }); return { verdict: 'fail', reason: '' }; }, { anchorId: 'oracle', timeoutMs: 100 });
  assert.equal(report.status, 'budget_exhausted'); assert.equal(report.finalVerified, false);
});
test('long container runs retain a bounded deadline and invalid budgets execute no workload', async () => {
  let calls = 0;
  const execute: Executor = async () => { calls++; return { verdict: 'fail', reason: 'Stable failure' }; };
  for (const timeoutMs of [99, 300_001, Infinity, NaN, 100.5]) {
    await assert.rejects(minimize(sequence(['oracle']), execute, { anchorId: 'oracle', timeoutMs }), /Invalid reduction budget/u);
  }
  assert.equal(calls, 0);
  const report = await minimize(sequence(['oracle']), execute, { anchorId: 'oracle', timeoutMs: 300_000 });
  assert.equal(report.status, 'completed'); assert.equal(report.finalVerified, true);
  assert.equal(report.limits.timeoutMs, 300_000); assert.equal(calls, 6);
});
test('JSON pointers escape slashes and tildes, compare structural values and reject inherited properties', () => {
  assert.equal(matches({ 'a/b': { '~x': { b: 2, a: 1 } } }, { '/a~1b/~0x': { a: 1, b: 2 } }), true);
  assert.equal(matches({}, { '/toString': null }), false);
});
test('capsule validation rejects unsafe or ambiguous inputs', async () => {
  const original = await example();
  const invalid: unknown[] = [
    { ...original, adapter: 'production' },
    { ...original, exec: 'anything' },
    { ...original, steps: [{ ...original.steps[0], path: 'https://example.com' }, ...original.steps.slice(1)] },
    { ...original, steps: [{ ...original.steps[0], path: '//example.com' }, ...original.steps.slice(1)] },
    { ...original, steps: [{ ...original.steps[0], path: '/\\example.com' }, ...original.steps.slice(1)] },
    { ...original, steps: [{ ...original.steps[0], body: {} }, ...original.steps.slice(1)] },
    { ...original, steps: [...original.steps, original.steps[0]] },
    { ...original, oracle: { ...original.oracle, success: original.oracle.failure } },
    { ...original, oracle: { ...original.oracle, failure: { '/total~8': 100 } } },
  ];
  for (const input of invalid) assert.throws(() => parseCapsule(input), InputError);
});
test('the real HTTP demo reduces from 16 to 5 steps and distinguishes the actual fixed fixture', async () => {
  const capsule = await example();
  const report = await minimize(capsule.steps, demoExecutor(capsule), { anchorId: capsule.oracle.stepId });
  assert.equal(report.status, 'completed'); assert.equal(report.originalSteps, 16); assert.equal(report.reducedSteps, 5);
  assert.deepEqual(report.reducedStepIds, ['create-cart', 'add-coffee', 'apply-coupon', 'change-quantity', 'checkout']);
  assert.equal(report.finalVerified, true);
  assert.equal(report.oneMinimal, false, 'Broken prerequisites are unresolved, not proofs of minimality');
  const reduced = capsule.steps.filter(step => report.reducedStepIds.includes(step.id));
  assert.equal((await demoExecutor(capsule)(reduced, AbortSignal.timeout(5000))).verdict, 'fail');
  assert.equal((await demoExecutor(capsule, true)(reduced, AbortSignal.timeout(5000))).verdict, 'pass');
  assert.equal((await demoExecutor(capsule, true)(capsule.steps, AbortSignal.timeout(5000))).verdict, 'pass');
  assert.equal((await demoExecutor(capsule)([capsule.steps.at(-1)!], AbortSignal.timeout(5000))).verdict, 'unresolved');
});
test('a single anchored request remains a valid, replayable capsule', async () => {
  const original = await example();
  const capsule = parseCapsule({ ...original, steps: [original.steps.at(-1)!] });
  assert.equal(capsule.steps.length, 1);
});
test('every HTTP replay starts with fresh state, including after an invalid replay', async () => {
  const capsule = await example();
  const execute = demoExecutor(capsule);
  for (let i = 0; i < 2; i++) {
    assert.equal((await execute(capsule.steps.filter(step => step.id !== 'create-cart'), AbortSignal.timeout(5000))).verdict, 'unresolved');
    assert.equal((await execute(capsule.steps, AbortSignal.timeout(5000))).verdict, 'fail');
  }
});
