import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimize } from '../src/core/minimize.ts';
import type { Step } from '../src/core/model.ts';

const steps: Step[] = ['required', 'oracle'].map(id => ({ id, method: 'GET', path: '/health' }));
test('deletion witnesses bind each retained step to its two fresh trial outcomes without extra executions', async () => {
  let calls = 0;
  const report = await minimize(steps, async candidate => { calls++; return { verdict: candidate.length === 2 ? 'fail' : 'pass', reason: 'Deterministic synthetic oracle' }; }, { anchorId: 'oracle' });
  assert.equal(report.status, 'completed'); assert.equal(report.oneMinimal, true); assert.equal(calls, 10);
  assert.deepEqual(report.deletionWitnesses, [
    { stepId: 'required', status: 'necessary', trialNumbers: [9, 10], outcomes: ['pass', 'pass'] },
    { stepId: 'oracle', status: 'anchor', trialNumbers: [], outcomes: [] },
  ]);
  for (const number of report.deletionWitnesses![0]!.trialNumbers) {
    const event = report.events.find(e => e.trial === number)!;
    assert.equal(event.omittedStepId, 'required'); assert.equal(event.phase, 'minimality'); assert.deepEqual(event.stepIds, ['oracle']);
  }
});
test('unresolved deletions remain distinct from necessity evidence', async () => {
  const report = await minimize(steps, async candidate => ({ verdict: candidate.length === 2 ? 'fail' : 'unresolved', reason: 'Missing prerequisite' }), { anchorId: 'oracle' });
  assert.equal(report.oneMinimal, false);
  assert.equal(report.deletionWitnesses![0]!.status, 'unresolved');
  assert.deepEqual(report.deletionWitnesses![0]!.outcomes, ['unresolved', 'unresolved']);
});
test('a fresh removable step exposes oracle drift rather than a certified minimum', async () => {
  let deletions = 0;
  const report = await minimize(steps, async candidate => ({ verdict: candidate.length === 2 || ++deletions > 2 ? 'fail' : 'pass', reason: 'Changing synthetic oracle' }), { anchorId: 'oracle' });
  assert.equal(report.status, 'inconclusive'); assert.equal(report.oneMinimal, false);
  assert.equal(report.deletionWitnesses![0]!.status, 'removable');
  assert.deepEqual(report.deletionWitnesses![0]!.outcomes, ['fail', 'fail']);
});
test('mixed fresh deletion outcomes cannot certify a necessary step', async () => {
  let deletions = 0;
  const report = await minimize(steps, async candidate => ({ verdict: candidate.length === 2 ? 'fail' : ++deletions === 4 ? 'fail' : 'pass', reason: 'Mixed synthetic oracle' }), { anchorId: 'oracle' });
  assert.equal(report.oneMinimal, false); assert.equal(report.deletionWitnesses![0]!.status, 'unresolved');
  assert.deepEqual(report.deletionWitnesses![0]!.outcomes, ['pass', 'fail']);
});
test('a budget interruption records its single completed trial but leaves the witness unchecked', async () => {
  const report = await minimize(steps, async candidate => ({ verdict: candidate.length === 2 ? 'fail' : 'pass', reason: 'Deterministic oracle' }), { anchorId: 'oracle', maxTrials: 9 });
  assert.equal(report.status, 'budget_exhausted'); assert.equal(report.finalVerified, true); assert.equal(report.oneMinimal, false);
  assert.deepEqual(report.deletionWitnesses![0], { stepId: 'required', status: 'unchecked', trialNumbers: [9], outcomes: ['pass'] });
});
test('cancellation during certification preserves the observation without declaring necessity', async () => {
  const controller = new AbortController();
  const report = await minimize(steps, async candidate => ({ verdict: candidate.length === 2 ? 'fail' : 'pass', reason: 'Deterministic oracle' }), { anchorId: 'oracle', signal: controller.signal, onEvent: event => { if (event.phase === 'minimality') controller.abort(); } });
  assert.equal(report.status, 'cancelled'); assert.equal(report.oneMinimal, false);
  assert.equal(report.deletionWitnesses![0]!.status, 'unchecked'); assert.deepEqual(report.deletionWitnesses![0]!.trialNumbers, [9]);
});
test('unvisited steps are explicitly unchecked and the protected anchor is never called proven necessary', async () => {
  const report = await minimize(steps, async () => ({ verdict: 'fail', reason: 'Baseline' }), { anchorId: 'oracle', maxTrials: 3 });
  assert.deepEqual(report.deletionWitnesses, [
    { stepId: 'required', status: 'unchecked', trialNumbers: [], outcomes: [] },
    { stepId: 'oracle', status: 'anchor', trialNumbers: [], outcomes: [] },
  ]);
});
