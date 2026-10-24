import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseExecution, createArguments } from '../src/sandbox/policy.ts';
import { docker, preflight, inspectOwned, verifyRestrictions } from '../src/sandbox/docker.ts';
import { createLease, removeOwned, recoverLeases } from '../src/sandbox/leases.ts';
import { createCluster } from '../src/postgres/cluster.ts';
import { loadApplication } from '../src/postgres/config.ts';
import { prepareApplication } from '../src/postgres/environment.ts';
import { createSandbox } from '../src/sandbox/host.ts';
import { parseCapsule } from '../src/core/model.ts';

// This script always needs a REAL Linux engine. Missing Docker is a failure, never a skip.
const image = process.env.REPROPACK_SANDBOX_IMAGE;
const execution = parseExecution({ kind: 'docker', image, module: '/opt/repropack/examples/postgres-app/app.ts', fixedModule: '/opt/repropack/examples/postgres-app/fixed.ts' });
const engine = await preflight(execution);
const directory = await mkdtemp(join(tmpdir(), 'rp-docker-smoke-'));
let cluster; let environment;
const leases = join(directory, 'leases');
async function waitFor(check) { const until = Date.now() + 25_000; while (Date.now() < until) { if (await check()) return; await delay(100); } throw new Error('Timed out waiting for sandbox lifecycle'); }
async function rawProbe(code) {
  const lease = await createLease(leases, engine.engineId);
  let removed = false;
  try {
    const args = createArguments(execution, lease.container, lease.owner, lease.scope);
    args.splice(-1, 1, '--eval', code);
    const id = (await docker(args)).trim();
    verifyRestrictions(await inspectOwned(id, lease.owner, lease.scope), execution);
    let output = '';
    try { output = await docker(['start', '--attach', '--interactive', id], { input: '', timeoutMs: 12_000, maxBytes: 8192 }); } catch { /* inspect real kernel exit below */ }
    return { output, state: (await inspectOwned(id, lease.owner, lease.scope)).State };
  } finally { try { await removeOwned(lease.container, lease.owner, lease.scope, docker, engine.engineId); removed = true; } finally { await lease.close(removed); } }
}
try {
  cluster = await createCluster(join(directory, 'postgres'));
  const config = await loadApplication(fileURLToPath(new URL('../examples/postgres-app/repropack.json', import.meta.url)));
  config.execution = execution;
  environment = await prepareApplication(cluster, config);
  const capsule = parseCapsule(JSON.parse(await readFile(new URL('../examples/postgres-cart.json', import.meta.url), 'utf8')));
  const steps = capsule.steps.filter(step => ['apply-coupon', 'change-quantity', 'checkout'].includes(step.id));
  assert.equal((await environment.executor(capsule)(capsule.steps, AbortSignal.timeout(30_000))).verdict, 'fail');
  assert.equal((await environment.executor(capsule)(steps, AbortSignal.timeout(30_000))).verdict, 'fail');
  assert.equal((await environment.executor(capsule, true)(steps, AbortSignal.timeout(30_000))).verdict, 'pass');

  const module = fileURLToPath(new URL('../examples/sandbox-probe/app.ts', import.meta.url));
  const probeExecution = parseExecution({ kind: 'docker', image, module: '/opt/repropack/examples/sandbox-probe/app.ts' });
  const probe = parseCapsule({ schemaVersion: 2, adapter: 'node-http-postgres', application: config.id, snapshot: config.snapshot.id, title: 'Isolation probe', description: 'Real network/filesystem/credential checks', steps: [{ id: 'probe', method: 'GET', path: '/probe' }], oracle: { stepId: 'probe', status: 200, failure: { '/rootWriteDenied': true, '/rootReadOnly': true, '/networkDenied': true, '/socketDenied': true, '/noExternalInterface': true, '/hostSecret': false }, success: { '/rootWriteDenied': false } } });
  const input = { capsule: probe, steps: probe.steps, snapshot: environment.snapshot, schema: config.schema, module: probeExecution.module, moduleHash: createHash('sha256').update(await readFile(module)).digest('hex') };
  process.env.REPROPACK_HOST_SECRET = 'must-remain-on-host';
  const sandbox = await createSandbox(probeExecution, leases);
  assert.equal((await sandbox.execute(input, AbortSignal.timeout(30_000))).verdict, 'fail');
  delete process.env.REPROPACK_HOST_SECRET;

  const cgroups = await rawProbe(`const fs=require('node:fs'); console.log(JSON.stringify({memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),cpu:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),status:fs.readFileSync('/proc/self/status','utf8')}));`);
  assert.equal(cgroups.state.ExitCode, 0);
  const limits = JSON.parse(cgroups.output);
  assert.equal(limits.memory, String(512 * 1024 ** 2)); assert.equal(limits.pids, '64');
  const [quota, period] = limits.cpu.split(/\s+/).map(Number); assert.equal(quota / period, 1);
  assert.match(limits.status, /NoNewPrivs:\s+1/); assert.match(limits.status, /Seccomp:\s+2/); assert.match(limits.status, /CapEff:\s+0+/);
  const oom = await rawProbe(`const buffers=[];setInterval(()=>buffers.push(Buffer.alloc(32*1024*1024,1)),5);`);
  assert.equal(oom.state.OOMKilled, true, 'A real cgroup OOM kill is required');
  const pids = await rawProbe(`const {spawn}=require('node:child_process');let done=false;for(let i=0;i<100;i++){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.on('error',e=>{if(e.code==='EAGAIN'&&!done){done=true;console.log('PID_LIMIT_ENFORCED');}});}setTimeout(()=>process.exit(done?0:1),1000);`);
  assert.equal(pids.state.ExitCode, 0); assert.match(pids.output, /PID_LIMIT_ENFORCED/);

  const spinning = { ...input, capsule: { ...probe, steps: [{ id: 'probe', method: 'GET', path: '/spin' }] }, steps: [{ id: 'probe', method: 'GET', path: '/spin' }] };
  const short = await createSandbox({ ...probeExecution, quotas: { ...probeExecution.quotas, wallMs: 3000 } }, leases);
  const limited = await short.execute(spinning, AbortSignal.timeout(20_000));
  assert.equal(limited.verdict, 'unresolved'); assert.match(limited.reason, /wall-clock/);

  const crashDirectory = join(directory, 'crash-leases');
  const parent = fork(fileURLToPath(new URL('../test/fixtures/sandbox-parent.ts', import.meta.url)), [], { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(parent, 'exit');
  try {
    parent.send({ execution: { ...probeExecution, quotas: { ...probeExecution.quotas, wallMs: 30_000 } }, directory: crashDirectory, trial: spinning });
    await waitFor(async () => { const files = await readdir(crashDirectory).catch(() => []); if (!files.length) return false; const lease = JSON.parse(await readFile(join(crashDirectory, files[0]), 'utf8')); const value = await inspectOwned(lease.container, lease.owner, lease.scope).catch(() => undefined); return value?.State?.Running === true; });
    parent.kill('SIGKILL'); await exited;
    await waitFor(async () => (await readdir(crashDirectory)).length === 0);
  } finally { if (parent.exitCode === null && parent.signalCode === null) { parent.kill('SIGKILL'); await exited; } }
  assert.equal(await recoverLeases(leases), 0);
  console.log('REAL Docker smoke passed: native snapshot → container failure/fix, host secret exclusion, no external network, read-only root, actual cgroup limits/OOM/PID enforcement, wall deadline, parent crash cleanup.');
} finally {
  delete process.env.REPROPACK_HOST_SECRET;
  try { await environment?.close(); } finally { await cluster?.close(); }
  await rm(directory, { recursive: true, force: true });
}
