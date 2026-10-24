import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { InputError } from '../core/model.ts';
import { parseExecution } from '../sandbox/policy.ts';
import type { DockerExecution } from '../sandbox/policy.ts';

export interface RootSelection { table: string; where: Record<string, string | number | boolean | null> }
export interface SnapshotSpec {
  id: string;
  tables: string[];
  roots: RootSelection[];
  childrenOf: string[];
  maxRows: number;
  redact: { table: string; column: string; kind: 'text' | 'email' }[];
}
export interface ApplicationConfig {
  id: string;
  module: string;
  fixedModule?: string;
  fixedModuleHash?: string;
  schema: string;
  seed?: string;
  sourceUrlEnv?: string;
  snapshot: SnapshotSpec;
  moduleHash: string;
  execution?: DockerExecution;
}
const id = /^[a-z][a-z0-9_-]{0,63}$/u;
const identifier = /^[a-z_][a-z0-9_]{0,62}$/u;
export const validTable = (table: unknown): table is string => typeof table === 'string' && table.split('.').length === 2 && table.split('.').every(part => identifier.test(part)) && !table.startsWith('pg_') && !table.startsWith('information_schema.');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected a configuration object');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new InputError('Unsupported application configuration field');
}
export function parseSnapshot(raw: unknown): SnapshotSpec {
  const value = object(raw); fields(value, ['id', 'tables', 'roots', 'childrenOf', 'maxRows', 'redact']);
  if (typeof value.id !== 'string' || !id.test(value.id)) throw new InputError('Invalid snapshot ID');
  if (!Array.isArray(value.tables) || !value.tables.length || value.tables.length > 20 || !value.tables.every(validTable) || new Set(value.tables).size !== value.tables.length) throw new InputError('Snapshot tables must be 1–20 unique schema.table identifiers');
  const tables = value.tables as string[];
  const childrenOf = value.childrenOf ?? [];
  if (!Array.isArray(childrenOf) || !childrenOf.every(table => tables.includes(table))) throw new InputError('childrenOf must contain allowlisted tables');
  if (!Array.isArray(value.roots) || !value.roots.length || value.roots.length > 20) throw new InputError('Snapshot needs 1–20 root selections');
  const roots = value.roots.map(raw => {
    const root = object(raw); fields(root, ['table', 'where']);
    if (typeof root.table !== 'string' || !tables.includes(root.table)) throw new InputError('Root table is not allowlisted');
    const where = object(root.where);
    if (!Object.keys(where).length || Object.keys(where).length > 10 || !Object.keys(where).every(key => identifier.test(key))) throw new InputError('Root selectors must use named columns');
    for (const item of Object.values(where)) if (item !== null && typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isSafeInteger(item))) throw new InputError('Root values must be strings, safe integers, booleans or null');
    return { table: root.table, where: where as RootSelection['where'] };
  });
  const maxRows = value.maxRows ?? 200;
  if (!Number.isInteger(maxRows) || (maxRows as number) < 1 || (maxRows as number) > 1000) throw new InputError('maxRows must be 1–1000');
  const rawRedact = value.redact ?? [];
  if (!Array.isArray(rawRedact) || rawRedact.length > 50) throw new InputError('Invalid redaction rules');
  const redact = rawRedact.map(raw => {
    const rule = object(raw); fields(rule, ['table', 'column', 'kind']);
    if (typeof rule.table !== 'string' || !tables.includes(rule.table) || typeof rule.column !== 'string' || !identifier.test(rule.column) || !['text', 'email'].includes(rule.kind as string)) throw new InputError('Invalid column redaction rule');
    return rule as unknown as SnapshotSpec['redact'][number];
  });
  if (new Set(redact.map(rule => `${rule.table}.${rule.column}`)).size !== redact.length) throw new InputError('Duplicate column redaction rule');
  return { id: value.id, tables, roots, childrenOf: childrenOf as string[], maxRows: maxRows as number, redact };
}
export async function loadApplication(file: string): Promise<ApplicationConfig> {
  const full = await realpath(file);
  const boundary = dirname(full);
  const raw = JSON.parse(await readFile(full, 'utf8')) as unknown;
  const value = object(raw); fields(value, ['id', 'module', 'fixedModule', 'schema', 'seed', 'sourceUrlEnv', 'snapshot', 'execution']);
  if (typeof value.id !== 'string' || !id.test(value.id)) throw new InputError('Invalid application ID');
  async function localFile(raw: unknown, label: string) {
    if (typeof raw !== 'string' || !raw.startsWith('./')) throw new InputError(`${label} must be relative to the trusted configuration`);
    const actual = await realpath(resolve(boundary, raw)); const path = relative(boundary, actual);
    if (!path || path.startsWith('..') || isAbsolute(path)) throw new InputError(`${label} must stay inside the configuration directory`);
    return actual;
  }
  const module = await localFile(value.module, 'module');
  if (!/\.(?:ts|mjs|js)$/u.test(module)) throw new InputError('Application module must be TypeScript or JavaScript');
  const schema = await readFile(await localFile(value.schema, 'schema'), 'utf8');
  if (schema.length > 262_144) throw new InputError('Schema exceeds 256 KiB');
  const config: ApplicationConfig = { id: value.id, module, schema, snapshot: parseSnapshot(value.snapshot), moduleHash: createHash('sha256').update(await readFile(module)).digest('hex') };
  if (value.fixedModule !== undefined) {
    config.fixedModule = await localFile(value.fixedModule, 'fixedModule');
    if (!/\.(?:ts|mjs|js)$/u.test(config.fixedModule)) throw new InputError('Fixed module must be TypeScript or JavaScript');
    config.fixedModuleHash = createHash('sha256').update(await readFile(config.fixedModule)).digest('hex');
  }
  if (value.seed !== undefined) config.seed = await readFile(await localFile(value.seed, 'seed'), 'utf8');
  if (value.sourceUrlEnv !== undefined) {
    if (typeof value.sourceUrlEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,80}$/u.test(value.sourceUrlEnv) || value.seed !== undefined) throw new InputError('Use a sourceUrlEnv or a local seed, not both');
    config.sourceUrlEnv = value.sourceUrlEnv;
  }
  if (value.execution !== undefined) {
    config.execution = parseExecution(value.execution);
    if (Boolean(config.fixedModule) !== Boolean(config.execution.fixedModule)) throw new InputError('Host and sandbox fixedModule declarations must agree');
  }
  return config;
}
