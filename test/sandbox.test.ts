import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExecution, defaults, labels } from '../src/sandbox/policy.ts';
import { preflight } from '../src/sandbox/docker.ts';
import type { DockerCommand } from '../src/sandbox/docker.ts';
import { managedTrial } from '../src/sandbox/managed.ts';
import { createLease, leaseRoot, recoverLeases } from '../src/sandbox/leases.ts';

const image = `sha256:${'a'.repeat(64)}`;
const execution = parseExecution({ kind: 'docker', image, module: '/workspace/app.ts' });

/** A daemon protocol double: these checks deliberately do not claim kernel isolation. */
function daemon(options: { tamper?: boolean; oom?: boolean; wait?: boolean; malformed?: boolean; cleanupError?: boolean } = {}) {
  const id = 'b'.repeat(64); const calls: string[][] = []; let container: Record<string, any> | undefined;
  const command: DockerCommand = async (args, commandOptions = {}) => {
    calls.push(args);
    if (args[0] === 'info') return JSON.stringify({ ID: 'test-engine-000', OSType: 'linux', CgroupVersion: '2', MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin'] });
    if (args[0] === 'image') return JSON.stringify([{ Id: image, Os: 'linux', Config: {} }]);
    if (args[0] === 'create') {
      const labelValues = args.flatMap((value, index) => value === '--label' ? [args[index + 1]!.split('=')] : []);
      const tmpfs = Object.fromEntries(args.flatMap((value, index) => value === '--tmpfs' ? [args[index + 1]!.split(':')] : []));
      container = { Id: id, Image: image, Config: { User: '10001:10001', Labels: Object.fromEntries(labelValues) }, State: { OOMKilled: options.oom ?? false }, HostConfig: { NetworkMode: 'none', ReadonlyRootfs: !options.tamper, Memory: 512 * 1024 ** 2, MemorySwap: 512 * 1024 ** 2, NanoCpus: 1e9, PidsLimit: 64, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges=true'], Tmpfs: tmpfs, ShmSize: 8 * 1024 ** 2, RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none' } }, Mounts: [] };
      return id;
    }
    if (args[0] === 'container') return JSON.stringify([container]);
    if (args[0] === 'ps') return container ? id : '';
    if (args[0] === 'rm') { if (options.cleanupError) throw new Error('daemon offline'); container = undefined; return id; }
    if (args[0] === 'start') {
      if (options.oom) throw new Error('exit 137');
      if (options.wait) {
        await new Promise<void>((resolve, reject) => {
          if (commandOptions.signal?.aborted) reject(commandOptions.signal.reason);
          else commandOptions.signal?.addEventListener('abort', () => reject(commandOptions.signal!.reason), { once: true });
        });
      }
      return options.malformed ? 'private stdout that must not become an oracle' : JSON.stringify({ verdict: 'fail', reason: 'DO_NOT_PERSIST', observation: { password: 'DO_NOT_PERSIST' } });
    }
    throw new Error('Unexpected daemon command');
  };
  return { command, calls, container: () => container };
}
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'rp-sandbox-')); return { directory, close: () => rm(directory, { recursive: true, force: true }) }; }

test('sandbox policy requires immutable images, normalized module paths and bounded quotas', () => {
  assert.deepEqual(execution.quotas, defaults);
  for (const change of [{ image: 'node:latest' }, { module: '/workspace/../escape.ts' }, { module: '/workspace/evil\n.ts' }, { kind: 'native' }, { privileged: true }, { quotas: { memoryMiB: 0 } }, { quotas: { wallMs: Infinity } }, { quotas: { scratchMiB: 512 } }, { quotas: { cpus: 10 } }, { quotas: { toString: 1 } }]) assert.throws(() => parseExecution({ kind: 'docker', image, module: '/workspace/app.ts', ...change }));
});
test('missing engine features and persistent image volumes fail preflight before execution', async () => {
  const mock = daemon(); assert.equal((await preflight(execution, mock.command)).image, image);
  await assert.rejects(preflight(execution, async () => JSON.stringify({ OSType: 'windows' })), /Linux engine/u);
  await assert.rejects(preflight(execution, async (args, options) => args[0] === 'image' ? JSON.stringify([{ Id: image, Os: 'linux', Config: { Volumes: { '/data': {} } } }]) : mock.command(args, options)), /volumes/u);
});
test('sandbox keeps private stdout out of evidence and cleans only its exact owned container', async () => {
  const f = await fixture(); const mock = daemon();
  try {
    const result = await managedTrial(execution, '{}', f.directory, new AbortController().signal, mock.command);
    assert.equal(result.verdict, 'fail'); assert.doesNotMatch(JSON.stringify(result), /DO_NOT_PERSIST/u);
    assert.equal(mock.container(), undefined); assert.deepEqual(await readdir(f.directory), []);
    const create = mock.calls.find(args => args[0] === 'create')!;
    assert.ok(create.includes('--network=none')); assert.ok(create.includes('--read-only')); assert.ok(create.includes('--memory-swap=512m')); assert.ok(create.includes('--pids-limit=64'));
    assert.ok(!create.some(value => value === '--privileged' || value === '--publish' || value === '--volume' || value === '--mount'));
    assert.ok(mock.calls.find(args => args[0] === 'rm')?.includes('b'.repeat(64)));
  } finally { await f.close(); }
});
test('weakened daemon restrictions prevent start and still trigger cleanup', async () => {
  const f = await fixture(); const mock = daemon({ tamper: true });
  try { await assert.rejects(managedTrial(execution, '{}', f.directory, new AbortController().signal, mock.command), /restrictions/u); assert.ok(!mock.calls.some(args => args[0] === 'start')); assert.equal(mock.container(), undefined); }
  finally { await f.close(); }
});
test('a memory kill is inconclusive and never impersonates the requested failure', async () => {
  const f = await fixture(); const mock = daemon({ oom: true });
  try { const result = await managedTrial(execution, '{}', f.directory, new AbortController().signal, mock.command); assert.equal(result.verdict, 'unresolved'); assert.match(result.reason, /memory quota/u); assert.equal(mock.container(), undefined); }
  finally { await f.close(); }
});
test('cancel interrupts an attached trial, waits for container removal and leaves no journal', async () => {
  const f = await fixture(); const mock = daemon({ wait: true }); const controller = new AbortController();
  try {
    const promise = managedTrial(execution, '{}', f.directory, controller.signal, mock.command);
    const timer = setTimeout(() => controller.abort(new Error('test cancellation')), 50);
    try { await assert.rejects(promise, /test cancellation/u); } finally { clearTimeout(timer); }
    assert.equal(mock.container(), undefined); assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});
test('bad output cannot become a verdict; failed cleanup retains a recoverable ownership journal', async () => {
  const f = await fixture(); const mock = daemon({ malformed: true, cleanupError: true });
  try { await assert.rejects(managedTrial(execution, '{}', f.directory, new AbortController().signal, mock.command)); const files = await readdir(f.directory); assert.equal(files.length, 1); assert.doesNotMatch(await readFile(join(f.directory, files[0]!), 'utf8'), /private stdout|schema|password/u); }
  finally { await f.close(); }
});
test('recovery leaves live supervisors alone and removes a stale lease after an ownership check', async () => {
  const f = await fixture(); const mock = daemon(); const lease = await createLease(f.directory, 'test-engine-000');
  try {
    assert.equal(await recoverLeases(f.directory, mock.command), 0);
    assert.equal(mock.calls.length, 0);
    await lease.close(false);
    assert.equal(await recoverLeases(f.directory, mock.command), 1);
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await lease.close(true); await f.close(); }
});
test('recovery rejects a forged journal instead of acting on another container', async () => {
  const f = await fixture(); const mock = daemon(); const lease = await createLease(f.directory, 'test-engine-000');
  try {
    await lease.close(false);
    const { scope } = await leaseRoot(f.directory);
    await writeFile(join(f.directory, `${lease.owner}.json`), JSON.stringify({ version: 1, owner: lease.owner, scope, container: 'another-project', engineId: 'test-engine-000' }));
    await assert.rejects(recoverLeases(f.directory, mock.command), /ownership/u); assert.equal(mock.calls.length, 0);
  } finally { await f.close(); }
});
test('a successful lookup cannot authorize deletion when the actual labels do not match', async () => {
  const f = await fixture(); const lease = await createLease(f.directory, 'test-engine-000'); await lease.close(false);
  let removed = false;
  const command: DockerCommand = async args => {
    if (args[0] === 'info') return JSON.stringify({ ID: 'test-engine-000' });
    if (args[0] === 'ps') return 'c'.repeat(64);
    if (args[0] === 'container') return JSON.stringify([{ Id: 'c'.repeat(64), Config: { Labels: { [labels.owner]: 'different-owner' } } }]);
    removed = true; return '';
  };
  try { await assert.rejects(recoverLeases(f.directory, command), /ownership/u); assert.equal(removed, false); }
  finally { await f.close(); }
});

test('a changed Docker context cannot start work or erase another engines recovery journal', async () => {
  const f = await fixture(); const mock = daemon(); const lease = await createLease(f.directory, 'original-engine'); await lease.close(false);
  try {
    await assert.rejects(recoverLeases(f.directory, mock.command), /engine changed/u);
    assert.equal((await readdir(f.directory)).length, 1); assert.ok(!mock.calls.some(args => args[0] === 'rm' || args[0] === 'ps'));
    await assert.rejects(managedTrial(execution, '{}', f.directory, new AbortController().signal, mock.command, 'original-engine'), /engine changed/u);
    assert.ok(!mock.calls.some(args => args[0] === 'create'));
  } finally { await f.close(); }
});
