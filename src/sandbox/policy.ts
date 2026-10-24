import { posix } from 'node:path';
import { InputError } from '../core/model.ts';

export interface Quotas { memoryMiB: number; cpus: number; pids: number; scratchMiB: number; wallMs: number }
export interface DockerExecution { kind: 'docker'; image: string; module: string; fixedModule?: string; quotas: Quotas }
export const defaults: Quotas = { memoryMiB: 512, cpus: 1, pids: 64, scratchMiB: 192, wallMs: 15_000 };
export const imageId = /^sha256:[a-f0-9]{64}$/u;
export function parseExecution(raw: unknown): DockerExecution {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('execution must be an object');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['kind', 'image', 'module', 'fixedModule', 'quotas'].includes(key)) || value.kind !== 'docker' || typeof value.image !== 'string' || !imageId.test(value.image)) throw new InputError('Docker execution requires an immutable local sha256 image ID');
  const path = (raw: unknown) => {
    if (typeof raw !== 'string' || raw.length > 240 || !raw.startsWith('/') || posix.normalize(raw) !== raw || raw.includes('\\') || !/^\/[a-zA-Z0-9_./-]+\.(?:ts|mjs|js)$/u.test(raw)) throw new InputError('Sandbox module must be an absolute normalized Linux JavaScript/TypeScript path');
    return raw;
  };
  const quotas = { ...defaults };
  if (value.quotas !== undefined) {
    if (!value.quotas || typeof value.quotas !== 'object' || Array.isArray(value.quotas)) throw new InputError('Invalid sandbox quotas');
    const ranges = { memoryMiB: [256, 2048], cpus: [0.25, 2], pids: [16, 128], scratchMiB: [64, 512], wallMs: [3000, 30_000] } as const;
    for (const [key, item] of Object.entries(value.quotas)) {
      if (!Object.hasOwn(ranges, key)) throw new InputError('Unsupported sandbox quota');
      const name = key as keyof Quotas; const [min, max] = ranges[name];
      if (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max || (name !== 'cpus' && !Number.isInteger(item))) throw new InputError(`Invalid sandbox quota: ${name}`);
      quotas[name] = item;
    }
  }
  if (quotas.scratchMiB > quotas.memoryMiB / 2) throw new InputError('Scratch quota must not exceed half the memory quota');
  const execution: DockerExecution = { kind: 'docker', image: value.image, module: path(value.module), quotas };
  if (value.fixedModule !== undefined) execution.fixedModule = path(value.fixedModule);
  return execution;
}
export const labels = { owner: 'io.repropack.owner', scope: 'io.repropack.scope' };
export function createArguments(execution: DockerExecution, container: string, owner: string, scope: string) {
  const q = execution.quotas;
  return ['create', '--pull=never', '--name', container, '--label', `${labels.owner}=${owner}`, '--label', `${labels.scope}=${scope}`,
    '--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
    `--memory=${q.memoryMiB}m`, `--memory-swap=${q.memoryMiB}m`, `--cpus=${q.cpus}`, `--pids-limit=${q.pids}`,
    '--tmpfs', `/work:rw,nosuid,nodev,noexec,size=${q.scratchMiB}m,uid=10001,gid=10001,mode=0700`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,uid=10001,gid=10001,mode=0700',
    '--shm-size=8m', '--ulimit', 'nofile=256:256', '--ulimit', 'core=0:0', '--init', '--restart=no', '--no-healthcheck',
    '--log-driver=none', '--stop-timeout=1', '--workdir=/opt/repropack', '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=',
    '--env', 'REPROPACK_IN_SANDBOX=1', '--entrypoint=node', '--interactive', execution.image, '/opt/repropack/src/sandbox/trial.ts'];
}
