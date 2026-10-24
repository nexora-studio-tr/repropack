import { spawn } from 'node:child_process';
import type { DockerExecution } from './policy.ts';
import { labels } from './policy.ts';

export interface CommandOptions { input?: string; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number }
export type DockerCommand = (args: string[], options?: CommandOptions) => Promise<string>;
export class DockerError extends Error {}
export function engineIdentity(info: Record<string, unknown>): string {
  if (typeof info.ID !== 'string' || !/^[a-zA-Z0-9:_-]{8,200}$/u.test(info.ID)) throw new DockerError('Docker did not provide a stable engine identity');
  return info.ID;
}
export async function currentEngine(command: DockerCommand = docker) { return engineIdentity(JSON.parse(await command(['info', '--format', '{{json .}}'])) as Record<string, unknown>); }
export function requireLinuxEngine(info: Record<string, unknown>) {
  if (info.OSType !== 'linux' || info.CgroupVersion !== '2' || !['MemoryLimit', 'SwapLimit', 'CpuCfsQuota', 'PidsLimit'].every(key => info[key] === true) || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.includes('name=seccomp,profile=builtin')) throw new DockerError('Sandbox requires a Linux engine with cgroup v2, memory/swap, CPU, PID limits and default seccomp support.');
  return engineIdentity(info);
}

/** No shell, daemon socket mount, environment credentials or raw daemon error output. */
export const docker: DockerCommand = async (args, options = {}) => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) if (process.env[key]) env[key] = process.env[key];
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0; let failure: Error | undefined;
    const stop = (message: string) => { failure ??= new DockerError(message); child.kill(); };
    const timer = setTimeout(() => stop('Docker command exceeded its deadline'), options.timeoutMs ?? 10_000);
    const abort = () => stop('Sandbox cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.maxBytes ?? 262_144)) stop('Sandbox output exceeded its limit'); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.maxBytes ?? 262_144)) stop('Sandbox output exceeded its limit'); });
    child.stdin.on('error', () => undefined);
    child.on('error', () => { failure = new DockerError('Docker is unavailable. Install/start a Linux Docker engine; native fallback is disabled.'); });
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new DockerError('Docker operation failed; container output is withheld. Check the local engine and image.'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    if (options.signal?.aborted) abort();
    child.stdin.end(options.input);
  });
};
export async function preflight(execution: DockerExecution, command: DockerCommand = docker) {
  const info = JSON.parse(await command(['info', '--format', '{{json .}}'])) as Record<string, unknown>;
  requireLinuxEngine(info);
  const images = JSON.parse(await command(['image', 'inspect', execution.image])) as Array<{ Id: string; Os: string; Config?: { Volumes?: unknown; Env?: string[] } }>;
  const image = images[0];
  if (images.length !== 1 || image?.Id !== execution.image || image.Os !== 'linux' || Object.keys(image.Config?.Volumes ?? {}).length) throw new DockerError('Sandbox image is missing, mismatched, non-Linux or declares persistent volumes. No image is pulled automatically.');
  return { kind: 'docker' as const, image: execution.image, engineId: engineIdentity(info), network: 'none' as const, quotas: execution.quotas };
}
export async function inspectOwned(container: string, owner: string, scope: string, command: DockerCommand = docker) {
  const containers = JSON.parse(await command(['container', 'inspect', container])) as Array<Record<string, any>>;
  const value = containers[0];
  if (containers.length !== 1 || !value || !/^[a-f0-9]{64}$/u.test(value.Id) || value.Config?.Labels?.[labels.owner] !== owner || value.Config?.Labels?.[labels.scope] !== scope) throw new DockerError('Refusing to operate on a container without exact ownership labels.');
  return value;
}
export function verifyRestrictions(value: Record<string, any>, execution: DockerExecution) {
  const h = value.HostConfig; const q = execution.quotas;
  const tmpfs = (path: string, size: number) => typeof h?.Tmpfs?.[path] === 'string' && h.Tmpfs[path].split(',').sort().join(',') === `rw,nosuid,nodev,noexec,size=${size}m,uid=10001,gid=10001,mode=0700`.split(',').sort().join(',');
  if (value.Image !== execution.image || value.Config?.User !== '10001:10001' || h?.NetworkMode !== 'none' || h.ReadonlyRootfs !== true || h.Privileged ||
    h.Memory !== q.memoryMiB * 1024 ** 2 || h.MemorySwap !== h.Memory || h.NanoCpus !== q.cpus * 1e9 || h.PidsLimit !== q.pids ||
    !h.CapDrop?.includes('ALL') || h.CapAdd?.length || !h.SecurityOpt?.includes('no-new-privileges=true') || h.Binds?.length || value.Mounts?.some((mount: { Type?: string; Destination?: string }) => mount.Type !== 'tmpfs' || !['/work', '/tmp'].includes(mount.Destination ?? '')) ||
    Object.keys(h.PortBindings ?? {}).length || h.Devices?.length || h.RestartPolicy?.Name !== 'no' || h.LogConfig?.Type !== 'none' ||
    Object.keys(h.Tmpfs ?? {}).sort().join(',') !== '/tmp,/work' || !tmpfs('/work', q.scratchMiB) || !tmpfs('/tmp', 16) || h.PidMode || h.UTSMode || h.ShmSize !== 8 * 1024 ** 2 || h.DeviceRequests?.length) throw new DockerError('Engine did not retain required sandbox restrictions; execution refused.');
}
