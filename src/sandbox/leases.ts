import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { docker, inspectOwned, DockerError, currentEngine, engineIdentity } from './docker.ts';
import type { DockerCommand } from './docker.ts';
import { labels } from './policy.ts';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const endpoint = (scope: string, owner: string) => process.platform === 'win32' ? `\\\\.\\pipe\\repropack-${scope}-${owner}` : join(tmpdir(), `rp-${scope}-${owner}.sock`);
export async function leaseRoot(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new DockerError('Lease root must not be a symlink');
  const root = await realpath(directory);
  return { root, scope: createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 20) };
}
async function live(scope: string, owner: string) {
  return await new Promise<'live' | 'absent' | 'unknown'>(resolve => {
    const socket = createConnection(endpoint(scope, owner));
    let text = '';
    const finish = (value: 'live' | 'absent' | 'unknown') => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish('unknown'), 750);
    socket.once('error', (error: NodeJS.ErrnoException) => finish(['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '') ? 'absent' : 'unknown'));
    socket.once('connect', () => socket.write(owner));
    socket.on('data', chunk => { text += String(chunk); if (text === owner) finish('live'); else if (text.length > 100) finish('unknown'); });
    socket.once('end', () => finish(text === owner ? 'live' : 'unknown'));
  });
}
export async function removeOwned(container: string, owner: string, scope: string, command: DockerCommand = docker, expectedEngine?: string) {
  if (expectedEngine && await currentEngine(command) !== expectedEngine) throw new DockerError('Docker engine changed; retain the journal and restore the original context before recovery.');
  // A filtered list distinguishes an absent resource from an unavailable daemon. No blanket prune.
  const ids = (await command(['ps', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${container}$`, '--filter', `label=${labels.owner}=${owner}`, '--filter', `label=${labels.scope}=${scope}`])).trim().split(/\s+/u).filter(Boolean);
  for (const id of ids) {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new DockerError('Invalid owned container ID');
    await inspectOwned(id, owner, scope, command);
    await command(['rm', '--force', id], { timeoutMs: 15_000 });
  }
}
export async function recoverLeases(directory: string, command: DockerCommand = docker) {
  const { root, scope } = await leaseRoot(directory);
  let recovered = 0;
  for (const file of await readdir(root, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.json') || !uuid.test(file.name.slice(0, -5))) continue;
    const path = join(root, file.name); const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 4096) throw new DockerError('Invalid sandbox recovery journal');
    const record = JSON.parse(await readFile(path, 'utf8')) as { version?: number; owner?: string; scope?: string; container?: string; engineId?: string };
    const owner = file.name.slice(0, -5);
    if (record.version !== 1 || record.owner !== owner || record.scope !== scope || record.container !== `rp-${owner}`) throw new DockerError('Invalid sandbox recovery ownership');
    engineIdentity({ ID: record.engineId });
    const state = await live(scope, owner);
    if (state === 'live') continue;
    if (state === 'unknown') throw new DockerError('Supervisor liveness is uncertain; retain its journal and do not remove its container.');
    await removeOwned(record.container, owner, scope, command, record.engineId);
    await rm(path); recovered++;
    if (process.platform !== 'win32') await rm(endpoint(scope, owner), { force: true });
  }
  return recovered;
}
export async function createLease(directory: string, engineId: string) {
  engineIdentity({ ID: engineId });
  const { root, scope } = await leaseRoot(directory); const owner = randomUUID(); const container = `rp-${owner}`;
  const socketPath = endpoint(scope, owner);
  const server = createServer(socket => {
    let input = ''; socket.setTimeout(500, () => socket.destroy());
    socket.on('data', data => { input += String(data); if (input.length >= owner.length) socket.end(input === owner ? owner : 'invalid'); });
    socket.on('error', () => undefined);
  });
  const listening = once(server, 'listening'); server.listen(socketPath); await listening;
  const path = join(root, `${owner}.json`);
  try { await writeFile(path, JSON.stringify({ version: 1, owner, scope, container, engineId }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  return { owner, scope, container, async close(removeJournal: boolean) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (removeJournal) await rm(path, { force: true });
  } };
}
