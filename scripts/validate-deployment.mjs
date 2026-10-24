import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const execute = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url)), id = randomUUID();
const output = join(root, 'artifacts', 'deployment-validation', id); await mkdir(output, { recursive: true });
const meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const report = { schemaVersion: 1, id, version: meta.version, startedAt: new Date().toISOString(), status: 'blocked', checksPassed: [], cleanup: [], remoteDeployment: false };
const resources = []; let engineId;
const run = async (args, env = process.env) => await execute('docker', args, { cwd: root, env, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
const currentEngine = async () => (await run(['info', '--format', '{{.ID}}'])).stdout.trim();
const check = (name, condition) => { if (!condition) throw new Error(`Deployment check failed: ${name}`); report.checksPassed.push(name); };
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
class Client {
  cookie = ''; csrf = '';
  constructor(origin) { this.origin = origin; }
  async request(path, value) {
    const response = await fetch(this.origin + path, { method: value === undefined ? 'GET' : 'POST', headers: { origin: this.origin, 'content-type': 'application/json', 'x-repropack-local': '1', 'x-repropack-csrf': this.csrf, cookie: this.cookie }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(30_000) });
    const cookie = response.headers.get('set-cookie'); if (cookie) this.cookie = cookie.split(';')[0]; return response;
  }
  async session() { const value = await (await this.request('/api/session')).json(); this.csrf = value.csrf ?? ''; return value; }
}
async function finished(client, id) {
  for (let i = 0; i < 180; i++) { const value = await (await client.request(`/api/runs/${id}`)).json(); if (!['running', 'queued'].includes(value.status)) return value; await pause(500); }
  throw new Error('Container replay did not finish');
}
async function provision(demo) {
  const exposed = await port(), origin = `http://127.0.0.1:${exposed}`, project = `rp-validate-${id.slice(0, 8)}-${demo ? 'demo' : 'private'}`, file = demo ? 'compose.demo.yaml' : 'compose.yaml', service = demo ? 'demo' : 'app';
  const env = { ...process.env, REPROPACK_DEPLOYMENT_OWNER: id, REPROPACK_PUBLIC_ORIGIN: origin, REPROPACK_HTTP_PORT: String(exposed), REPROPACK_DEMO_PORT: String(exposed), REPROPACK_CONTAINER_DATA_DIR: '/var/lib/repropack' };
  const args = ['compose', '--project-name', project, '--file', file]; const item = { project, args, env, service }; resources.push(item);
  await run([...args, 'up', '--detach', '--no-build', '--wait', '--wait-timeout', '90'], env);
  const container = (await run([...args, 'ps', '--quiet', service], env)).stdout.trim();
  const info = JSON.parse((await run(['container', 'inspect', container])).stdout)[0];
  check(`${service}-ownership`, info.Config.Labels['io.repropack.deployment-owner'] === id && info.Config.Labels['com.docker.compose.project'] === project);
  check(`${service}-nonroot-readonly-quotas`, info.Config.User === '10001:10001' && info.HostConfig.ReadonlyRootfs && info.HostConfig.CapDrop.includes('ALL') && info.HostConfig.PidsLimit > 0 && info.HostConfig.Memory > 0);
  check(`${service}-loopback-only-port`, Object.values(info.HostConfig.PortBindings).flat().every(binding => binding.HostIp === '127.0.0.1'));
  const executeIn = async command => JSON.parse((await run(['container', 'exec', container, 'node', '--input-type=module', '-e', command])).stdout);
  check(`${service}-uid`, await executeIn('console.log(JSON.stringify(process.getuid()))') === 10001);
  check(`${service}-health`, (await (await fetch(origin + '/healthz')).json()).status === 'ok');
  check(`${service}-ui`, (await fetch(origin)).status === 200);
  return { ...item, origin, container, info, executeIn, client: new Client(origin), restart: () => run([...args, 'restart', service], env) };
}
try {
  engineId = await currentEngine(); report.engineId = engineId;
  const image = JSON.parse((await run(['image', 'inspect', `repropack:${meta.version}`])).stdout)[0]; report.image = image.Id;
  if (image.Os !== 'linux' || image.Config.Labels['org.opencontainers.image.version'] !== meta.version) throw new Error('Build the matching Linux deployment image first');
  report.status = 'failed';
  const privateApp = await provision(false);
  const key = await privateApp.executeIn("import {readFileSync} from 'node:fs'; console.log(JSON.stringify(readFileSync('/var/lib/repropack/bootstrap-token','utf8').trim()))");
  check('private-first-owner-setup', (await privateApp.client.request('/api/auth/setup', { token: key, name: 'Deployment fixture', email: 'deployment@example.test', password: `fixture-only-${randomUUID()}`, teamName: 'Container fixture' })).status === 201);
  await privateApp.client.session();
  const capsule = JSON.parse(await readFile(join(root, 'examples/postgres-cart.json'), 'utf8'));
  const started = await privateApp.client.request('/api/runs', { capsule, maxTrials: 6 }); check('private-postgres-started', started.status === 202);
  const { id: runId } = await started.json(), completed = await finished(privateApp.client, runId);
  check('private-real-postgres-replay', completed.status === 'budget_exhausted' && completed.environment?.totalRows === 4 && completed.report?.baselineVerified === true && /PostgreSQL 18\./.test(completed.environment.postgresVersion));
  const backup = JSON.parse((await run(['container', 'exec', privateApp.container, 'node', 'scripts/backup.mjs'])).stdout);
  const restored = JSON.parse((await run(['container', 'exec', privateApp.container, 'node', 'scripts/restore.mjs', backup.backup, `/var/lib/repropack/restored-${id.slice(0, 8)}`])).stdout);
  check('container-backup-and-safe-restore', restored.sessionsRevoked && restored.invitationsRevoked);
  await privateApp.restart();
  for (let i = 0; i < 30; i++) { if (await fetch(privateApp.origin + '/healthz').then(r => r.ok).catch(() => false)) break; await pause(500); }
  check('private-data-and-session-survive-restart', (await privateApp.client.session()).setupRequired === false && (await privateApp.client.request(`/api/runs/${runId}`)).status === 200);
  const demo = await provision(true); check('demo-has-no-persistent-volume', demo.info.Mounts.every(mount => mount.Type === 'tmpfs' && mount.Destination === '/tmp'));
  const a = demo.client, b = new Client(demo.origin); check('demo-no-bootstrap', (await a.session()).setupRequired === false);
  check('demo-two-visitors', (await a.request('/api/demo/session', {})).status === 201 && (await b.request('/api/demo/session', {})).status === 201); await a.session(); await b.session();
  const publicStarted = await a.request('/api/runs', { capsule: JSON.parse(await readFile(join(root, 'examples/cart-discount.json'), 'utf8')) }); const { id: publicId } = await publicStarted.json();
  const reduced = await finished(a, publicId); check('container-demo-real-16-to-5', reduced.status === 'completed' && reduced.report.reducedSteps === 5 && reduced.report.finalVerified);
  check('container-demo-fix', (await (await a.request(`/api/runs/${publicId}/verify`, {})).json()).passed === true);
  check('container-demo-data-isolation', (await b.request(`/api/runs/${publicId}/report`)).status === 404 && (await a.request(`/api/runs/${runId}`)).status === 404 && (await a.request('/api/team')).status === 403);
  await demo.restart();
  for (let i = 0; i < 30; i++) { if (await fetch(demo.origin + '/healthz').then(r => r.ok).catch(() => false)) break; await pause(500); }
  check('demo-resets-on-restart', !(await a.session()).user && (await a.request('/api/runs')).status === 401);
  report.status = 'passed';
} catch (error) { report.reason = error.message; process.exitCode = 1; }
finally {
  for (const item of resources.reverse()) {
    try {
      if (!engineId || await currentEngine() !== engineId) throw new Error('Engine changed; owned test resources retained');
      const ids = (await run([...item.args, 'ps', '--all', '--quiet'], item.env)).stdout.trim().split(/\s+/).filter(Boolean);
      for (const container of ids) { const value = JSON.parse((await run(['container', 'inspect', container])).stdout)[0]; if (value.Config.Labels['io.repropack.deployment-owner'] !== id) throw new Error('Container ownership mismatch; test cleanup refused'); }
      const names = (await run(['volume', 'ls', '--filter', `label=com.docker.compose.project=${item.project}`, '--format', '{{.Name}}'])).stdout.trim().split(/\s+/).filter(Boolean);
      for (const volume of names) if (JSON.parse((await run(['volume', 'inspect', volume])).stdout)[0].Labels?.['io.repropack.deployment-owner'] !== id) throw new Error('Volume ownership mismatch; test cleanup refused');
      await run([...item.args, 'down', '--volumes'], item.env); report.cleanup.push({ project: item.project, status: 'removed-owned-resources' });
    } catch (error) { report.status = 'failed'; report.cleanup.push({ project: item.project, status: 'retained', reason: error.message }); process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString(); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, checks: report.checksPassed.length, reason: report.reason, report: join(output, 'report.json') }));
}
