import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { ownedPreviewId, requireDemoContainer } from '../src/deployment/preview-policy.ts';

const execute = promisify(execFile), root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const scope = createHash('sha256').update(root).digest('hex'), base = join(root, '.repropack', 'previews');
const docker = (args, timeout = 30_000) => execute('docker', args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
const engine = async () => (await docker(['info', '--format', '{{.ID}}'])).stdout.trim();
async function inspect(name) {
  try { return JSON.parse((await docker(['container', 'inspect', name])).stdout)[0]; }
  catch (error) { if (/No such (?:container|object)/u.test(error.stderr ?? '')) return; throw error; }
}
async function save(file, lease) { await writeFile(file, JSON.stringify(lease, null, 2) + '\n', { mode: 0o600 }); }
async function stop(lease, file) {
  if (lease.scope !== scope || lease.engineId !== await engine()) throw new Error('Restore the original Docker engine/workspace before stopping this preview');
  let unresolved = false;
  for (const resource of [...lease.resources].reverse()) {
    const value = await inspect(resource.id ?? resource.name);
    if (value) await docker(['container', 'rm', '--force', ownedPreviewId(value, lease, resource)]);
    else if (!resource.id) unresolved = true;
  }
  lease.status = unresolved ? 'cleanup-required' : 'stopped'; lease.stoppedAt = new Date().toISOString(); await save(file, lease);
  if (unresolved) throw new Error('A create operation was uncertain; retain the lease and run stop again after the engine settles');
}
async function image(reference) {
  const info = JSON.parse((await docker(['image', 'inspect', reference])).stdout)[0];
  if (!/^sha256:[a-f0-9]{64}$/u.test(info?.Id) || info.Os !== 'linux') throw new Error('The preview needs existing local Linux images. Build/pull the documented images first');
  return info.Id;
}
async function start() {
  const meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const appImage = await image(`repropack:${meta.version}`), tunnelImage = await image('cloudflare/cloudflared:latest'), owner = randomUUID();
  const directory = join(base, owner); await mkdir(directory, { recursive: true, mode: 0o700 }); const file = join(directory, 'lease.json');
  const lease = { schemaVersion: 1, owner, scope, engineId: await engine(), appImage, tunnelImage, resources: [], status: 'starting', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7_200_000).toISOString() };
  await save(file, lease);
  let closing = false;
  try {
    async function create(kind, imageId, args, command) {
      const resource = { kind, name: `rp-preview-${owner.slice(0, 8)}-${kind}` }; lease.resources.push(resource); await save(file, lease);
      const labels = ['--label', `io.repropack.preview.owner=${owner}`, '--label', `io.repropack.preview.scope=${scope}`, '--label', `io.repropack.preview.kind=${kind}`];
      resource.id = (await docker(['container', 'create', '--name', resource.name, ...labels, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', ...args, imageId, ...command])).stdout.trim();
      if (!/^[a-f0-9]{64}$/u.test(resource.id)) throw new Error('Docker did not provide a complete container ID');
      await save(file, lease); await docker(['container', 'start', resource.id]); return resource;
    }
    // No host port is exposed. Even a surviving tunnel cannot point at a later host process.
    const keeper = await create('keeper', appImage, ['--no-healthcheck', '--user', '10001:10001', '--memory', '96m', '--memory-swap', '96m', '--cpus', '0.25', '--pids-limit', '32', '--entrypoint', 'node'], ['-e', 'setTimeout(() => process.exit(0), 7200000)']);
    const tunnel = await create('tunnel', tunnelImage, ['--no-healthcheck', '--user', '65532:65532', '--network', `container:${keeper.id}`, '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777'], ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4320']);
    for (let i = 0; i < 40 && !lease.url; i++) {
      const log = await docker(['container', 'logs', '--tail', '100', tunnel.id]); const match = `${log.stdout}\n${log.stderr}`.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/u);
      if (match) lease.url = match[0]; else { const value = await inspect(tunnel.id); if (!value?.State?.Running) throw new Error('The Cloudflare preview client stopped before creating a URL'); await pause(1000); }
    }
    if (!lease.url) throw new Error('Cloudflare did not issue a temporary preview URL'); await save(file, lease);
    const web = await create('web', appImage, ['--user', '10001:10001', '--network', `container:${keeper.id}`, '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777', '--env', 'PORT=4320', '--env', 'REPROPACK_DEMO=1', '--env', 'REPROPACK_DATA_DIR=', '--env', `REPROPACK_PUBLIC_ORIGIN=${lease.url}`, '--env', 'REPROPACK_DEMO_LIFETIME_MS=7200000'], []);
    requireDemoContainer(await inspect(web.id), lease, keeper.id);
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      const response = await fetch(`${lease.url}/api/session`, { signal: AbortSignal.timeout(4000) }).catch(() => undefined);
      if (response?.ok) { const state = await response.json().catch(() => ({})); ready = state.setupRequired === false && state.demo?.ttlMinutes === 60 && !state.user; }
      if (!ready) { if (!(await inspect(web.id))?.State?.Running) throw new Error('The isolated demo stopped during startup'); await pause(1000); }
    }
    if (!ready) throw new Error('The external preview did not pass its demo-only readiness check');
    lease.status = 'ready'; await save(file, lease);
    console.log(JSON.stringify({ url: lease.url, expiresAt: lease.expiresAt, lease: file, isolatedDemo: true, hostPortsPublished: false }));
    await new Promise(resolveDone => {
      const finish = () => { if (closing) return; closing = true; clearTimeout(timer); clearInterval(watcher); resolveDone(); };
      const timer = setTimeout(finish, 7_200_000);
      const watcher = setInterval(() => { void inspect(web.id).then(value => { if (!value?.State?.Running) finish(); }).catch(finish); }, 15_000);
      process.once('SIGINT', finish); process.once('SIGTERM', finish);
    });
    await stop(lease, file);
  } catch (error) {
    lease.status = 'failed'; lease.reason = error.message; await save(file, lease);
    try { await stop(lease, file); } catch (cleanup) { console.error(`Preview cleanup needs attention: ${cleanup.message}\nLease: ${file}`); }
    throw error;
  }
}
try {
  if (process.argv[2] === 'start' && process.argv.length === 3) await start();
  else if (process.argv[2] === 'stop' && process.argv.length === 4) {
    const path = resolve(process.argv[3]); if (relative(base, path).startsWith(`..${sep}`) || path === base || !path.startsWith(`${base}${sep}`)) throw new Error('Preview lease must be inside this project’s .repropack/previews directory');
    const canonical = await realpath(path); if (!canonical.startsWith(`${await realpath(base)}${sep}`)) throw new Error('Preview lease escapes its owned directory');
    const lease = JSON.parse(await readFile(canonical, 'utf8')); await stop(lease, canonical); console.log('Owned preview containers stopped.');
  } else throw new Error('Use npm run demo:share, or node scripts/share-demo.mjs stop .repropack/previews/<id>/lease.json');
} catch (error) { console.error(error.message); process.exitCode = 1; }
