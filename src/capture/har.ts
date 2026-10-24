import { createHash, timingSafeEqual } from 'node:crypto';
import { parseCapsule, InputError } from '../core/model.ts';
import type { Capsule, Json, Step } from '../core/model.ts';

export interface CaptureDraft {
  reviewState: 'pending';
  formatVersion: 1;
  capsule: Capsule;
  summary: { imported: number; excludedOrigin: number; excludedNonJson: number; redactedValues: number; headersDiscarded: number };
  sha256: string;
}
const sensitive = /token|password|passwd|secret|authorization|cookie|api.?key|session/iu;
const pointerKey = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
const digest = (capsule: Capsule, summary: CaptureDraft['summary']) => createHash('sha256').update(JSON.stringify({ capsule, summary })).digest('hex');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid HAR object');
  return value as Record<string, unknown>;
}
/** Offline import only. Response payloads and all headers are deliberately never copied. */
export function importHar(raw: unknown, origin: string, base: Capsule, redactPointers: string[] = []): CaptureDraft {
  const selected = new URL(origin);
  if (!['http:', 'https:'].includes(selected.protocol) || selected.username || selected.password || selected.pathname !== '/' || selected.search || selected.hash) throw new InputError('Select an HTTP(S) origin without credentials, paths or query parameters');
  if (redactPointers.some(pointer => !pointer.startsWith('/') || /~(?![01])/u.test(pointer))) throw new InputError('Redaction paths must be JSON Pointers relative to each request body');
  const entries = record(record(raw).log).entries;
  if (!Array.isArray(entries) || entries.length > 10_000) throw new InputError('HAR needs an entries array with at most 10000 entries');
  const summary: CaptureDraft['summary'] = { imported: 0, excludedOrigin: 0, excludedNonJson: 0, redactedValues: 0, headersDiscarded: 0 };
  const pointers = new Set(redactPointers);
  function redact(value: Json, path = ''): Json {
    if (pointers.has(path)) { summary.redactedValues++; return '[REDACTED]'; }
    if (Array.isArray(value)) return value.map((item, index) => redact(item, `${path}/${index}`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (sensitive.test(key)) { summary.redactedValues++; return [key, '[REDACTED]']; }
      return [key, redact(item, `${path}/${pointerKey(key)}`)];
    }));
    return value;
  }
  const steps: Step[] = [];
  for (const rawEntry of entries) {
    const entry = record(rawEntry); const request = record(entry.request);
    if (typeof request.url !== 'string') throw new InputError('HAR request URL is missing');
    const url = new URL(request.url);
    if (url.origin !== selected.origin) { summary.excludedOrigin++; continue; }
    const response = record(entry.response);
    const content = record(response.content ?? {});
    const method = request.method;
    if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new InputError('HAR contains an unsupported HTTP method');
    if (typeof content.mimeType !== 'string' || !/(?:application\/(?:[^;]+\+)?json)(?:;|$)/iu.test(content.mimeType)) {
      if (method !== 'GET') throw new InputError('Non-JSON mutating requests cannot be faithfully imported');
      summary.excludedNonJson++; continue;
    }
    if (!Number.isInteger(response.status) || (response.status as number) < 100 || (response.status as number) > 599) throw new InputError('HAR contains a request without an HTTP response');
    for (const key of new Set(url.searchParams.keys())) if (sensitive.test(key)) { summary.redactedValues++; url.searchParams.set(key, '[REDACTED]'); }
    summary.headersDiscarded += Array.isArray(request.headers) ? request.headers.length : 0;
    const step: Step = { id: `capture-${String(steps.length + 1).padStart(3, '0')}`, method: method as Step['method'], path: url.pathname + url.search, expectStatus: response.status as number };
    if (request.postData !== undefined) {
      const post = record(request.postData);
      if (method === 'GET' || typeof post.text !== 'string' || post.text.length > 65_536 || typeof post.mimeType !== 'string' || !/^application\/(?:[^;]+\+)?json(?:;|$)/iu.test(post.mimeType) || post.encoding) throw new InputError('Only JSON request bodies up to 64 KiB can be imported');
      try { step.body = redact(JSON.parse(post.text) as Json); }
      catch { throw new InputError('HAR request body is not valid JSON'); }
    }
    steps.push(step);
    if (steps.length > 200) throw new InputError('Select a smaller HAR: capsules support at most 200 requests');
  }
  if (!steps.length) throw new InputError('No JSON requests matched the selected origin');
  summary.imported = steps.length;
  const capsule = parseCapsule({ ...base, steps, oracle: { ...base.oracle, stepId: steps.at(-1)!.id } });
  return { reviewState: 'pending', formatVersion: 1, capsule, summary, sha256: digest(capsule, summary) };
}
export function approveCapture(input: unknown, reviewedSha256: string) {
  const raw = record(input);
  if (raw.reviewState !== 'pending' || raw.formatVersion !== 1 || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sha256) || !/^[a-f0-9]{64}$/u.test(reviewedSha256)) throw new InputError('Provide a capture draft and its reviewed SHA-256');
  const capsule = parseCapsule(raw.capsule);
  const summary = record(raw.summary);
  const expectedKeys = ['imported', 'excludedOrigin', 'excludedNonJson', 'redactedValues', 'headersDiscarded'];
  if (Object.keys(summary).length !== expectedKeys.length || expectedKeys.some(key => !Number.isSafeInteger(summary[key]) || (summary[key] as number) < 0)) throw new InputError('Invalid capture summary');
  const computed = digest(capsule, summary as unknown as CaptureDraft['summary']);
  if (!timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(raw.sha256, 'hex')) || !timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(reviewedSha256, 'hex'))) throw new InputError('Capture changed or review hash does not match; review a newly generated draft');
  return { capsule, receipt: { formatVersion: 1, reviewedSha256: computed, reviewedAt: new Date().toISOString(), redactedValues: summary.redactedValues, note: 'Explicit local review receipt; not a guarantee of complete anonymization.' } };
}
