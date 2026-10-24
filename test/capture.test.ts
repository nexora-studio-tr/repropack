import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importHar, approveCapture } from '../src/capture/har.ts';
import { example, postgresExample } from '../src/server.ts';
import { parseCapsule } from '../src/core/model.ts';

const entry = (url: string, method = 'GET', body?: unknown, mime = 'application/json') => ({
  request: { url, method, headers: [{ name: 'Authorization', value: 'Bearer RAW_HEADER_SECRET' }], ...(body === undefined ? {} : { postData: { mimeType: 'application/json', text: JSON.stringify(body) } }) },
  response: { status: 200, content: { mimeType: mime, text: 'RAW_RESPONSE_SECRET' } },
});
test('offline HAR import masks credentials and explicit pointers without copying headers or response bodies', async () => {
  const har = { log: { entries: [entry('https://app.test/cart?token=RAW_QUERY_SECRET', 'POST', { password: 'RAW_BODY_SECRET', customer: { email: 'RAW_EMAIL' }, data: [{ secret: 'NESTED_SECRET' }] }), entry('https://other.test/ignore'), entry('https://app.test/style.css', 'GET', undefined, 'text/css'), entry('https://app.test/cart/checkout')] } };
  const draft = importHar(har, 'https://app.test', await example(), ['/customer/email']);
  assert.equal(draft.reviewState, 'pending'); assert.equal(draft.summary.imported, 2); assert.equal(draft.summary.excludedOrigin, 1); assert.equal(draft.summary.excludedNonJson, 1); assert.equal(draft.summary.redactedValues, 4);
  assert.equal(draft.capsule.oracle.stepId, 'capture-002');
  const serialized = JSON.stringify(draft);
  for (const secret of ['RAW_QUERY_SECRET', 'RAW_BODY_SECRET', 'RAW_EMAIL', 'NESTED_SECRET', 'RAW_HEADER_SECRET', 'RAW_RESPONSE_SECRET']) assert.equal(serialized.includes(secret), false);
  assert.throws(() => parseCapsule(draft));
  assert.deepEqual(approveCapture(draft, draft.sha256).capsule, draft.capsule);
});
test('capture approval binds the reviewed semantic capsule and rejects changed payloads or hashes', async () => {
  const draft = importHar({ log: { entries: [entry('http://localhost:9000/cart/checkout')] } }, 'http://localhost:9000', await postgresExample());
  const tampered = structuredClone(draft); tampered.capsule.title = 'Changed after review';
  assert.throws(() => approveCapture(tampered, draft.sha256), /changed|match/u);
  assert.throws(() => approveCapture(draft, '0'.repeat(64)), /changed|match/u);
  assert.equal(approveCapture(draft, draft.sha256).capsule.application, 'postgres-cart');
});
test('non-JSON mutations, missing responses and authenticated origin strings are rejected before export', async () => {
  const base = await example();
  assert.throws(() => importHar({ log: { entries: [entry('https://app.test/upload', 'POST', {}, 'text/plain')] } }, 'https://app.test', base), /Non-JSON/u);
  assert.throws(() => importHar({ log: { entries: [] } }, 'https://u:password@app.test', base), /credentials/u);
  assert.throws(() => importHar({ log: { entries: [] } }, 'https://app.test', base), /No JSON/u);
  const missing = entry('https://app.test/path'); missing.response.status = 0;
  assert.throws(() => importHar({ log: { entries: [missing] } }, 'https://app.test', base), /without an HTTP response/u);
});
