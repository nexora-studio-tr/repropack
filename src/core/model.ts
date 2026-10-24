import { isDeepStrictEqual } from 'node:util';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Checks = Record<string, Json>;
export interface Step {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Json;
  expectStatus?: number;
}
export interface Capsule {
  schemaVersion: 1 | 2;
  adapter: 'demo-cart' | 'node-http-postgres';
  application?: string;
  snapshot?: string;
  title: string;
  description: string;
  steps: Step[];
  oracle: { stepId: string; status: number; failure: Checks; success: Checks };
}
export class InputError extends Error {
  constructor(message: string) { super(message); this.name = 'InputError'; }
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${label}: expected an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new InputError(`${label}: unsupported field ${key}`);
}
function string(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InputError(`${label}: expected 1–${max} characters`);
  return value;
}
function status(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 599) throw new InputError(`${label}: invalid HTTP status`);
  return value as number;
}
function json(value: unknown, depth = 0): asserts value is Json {
  if (depth > 12) throw new InputError('JSON nesting exceeds 12 levels');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value) throw new InputError('Only finite JSON values are supported');
  for (const child of Object.values(value)) json(child, depth + 1);
}
function checks(value: unknown, label: string): Checks {
  const result = record(value, label);
  if (!Object.keys(result).length || Object.keys(result).length > 20) throw new InputError(`${label}: expected 1–20 JSON Pointer checks`);
  for (const [pointer, expected] of Object.entries(result)) {
    if (!pointer.startsWith('/') || pointer.length > 200 || /~(?![01])/u.test(pointer)) throw new InputError(`${label}: invalid JSON Pointer`);
    json(expected);
  }
  return result as Checks;
}
export function parseCapsule(input: unknown): Capsule {
  const value = record(input, 'capsule');
  if ('reviewState' in value) throw new InputError('This is a capture draft. Review it and run approve-capture before importing capsule.reviewed.json');
  keys(value, ['schemaVersion', 'adapter', 'application', 'snapshot', 'title', 'description', 'steps', 'oracle'], 'capsule');
  const isDemo = value.schemaVersion === 1 && value.adapter === 'demo-cart';
  const isPostgres = value.schemaVersion === 2 && value.adapter === 'node-http-postgres';
  if (!isDemo && !isPostgres) throw new InputError('Supported capsule formats: v1 demo-cart; v2 node-http-postgres');
  if (isDemo && ('application' in value || 'snapshot' in value)) throw new InputError('Application configuration does not belong in a v1 demo capsule');
  if (isPostgres && (typeof value.application !== 'string' || typeof value.snapshot !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value.application) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value.snapshot))) throw new InputError('PostgreSQL capsules require logical application and snapshot IDs; paths and credentials are not allowed');
  const title = string(value.title, 'title', 160);
  const description = string(value.description, 'description', 2000);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 200) throw new InputError('steps: expected 1–200 steps');
  const ids = new Set<string>();
  const steps = value.steps.map((raw, index): Step => {
    const step = record(raw, `steps[${index}]`);
    keys(step, ['id', 'method', 'path', 'body', 'expectStatus'], `steps[${index}]`);
    const id = string(step.id, 'step.id', 80);
    if (!/^[a-zA-Z0-9_-]+$/u.test(id) || ids.has(id)) throw new InputError('Step IDs must be unique letters, numbers, underscores or hyphens');
    ids.add(id);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(step.method as string)) throw new InputError('Unsupported HTTP method');
    const path = string(step.path, 'step.path', 1000);
    let url: URL;
    try { url = new URL(path, 'http://repropack.invalid'); }
    catch { throw new InputError('Invalid step path'); }
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || url.origin !== 'http://repropack.invalid' || url.hash) throw new InputError('Step paths must be relative HTTP paths without fragments');
    const parsed: Step = { id, method: step.method as Step['method'], path };
    if ('body' in step) {
      json(step.body);
      if (parsed.method === 'GET' || JSON.stringify(step.body).length > 65_536) throw new InputError('GET bodies and bodies larger than 64 KiB are unsupported');
      parsed.body = step.body;
    }
    if ('expectStatus' in step) parsed.expectStatus = status(step.expectStatus, 'expectStatus');
    return parsed;
  });
  const oracle = record(value.oracle, 'oracle');
  keys(oracle, ['stepId', 'status', 'failure', 'success'], 'oracle');
  const stepId = string(oracle.stepId, 'oracle.stepId', 80);
  if (steps.at(-1)?.id !== stepId) throw new InputError('The oracle must reference the final step');
  const failure = checks(oracle.failure, 'oracle.failure');
  const success = checks(oracle.success, 'oracle.success');
  if (!Object.keys(failure).some(key => Object.hasOwn(success, key) && !isDeepStrictEqual(failure[key], success[key]))) throw new InputError('Failure and success signatures must contain a conflicting check');
  const capsule: Capsule = { schemaVersion: isDemo ? 1 : 2, adapter: isDemo ? 'demo-cart' : 'node-http-postgres', title, description, steps, oracle: { stepId, status: status(oracle.status, 'oracle.status'), failure, success } };
  if (isPostgres) { capsule.application = value.application as string; capsule.snapshot = value.snapshot as string; }
  return structuredClone(capsule);
}
export function matches(body: Json, expected: Checks): boolean {
  return Object.entries(expected).every(([pointer, value]) => {
    let current: unknown = body;
    for (const part of pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return false;
      current = (current as Record<string, unknown>)[part];
    }
    return isDeepStrictEqual(current, value);
  });
}
