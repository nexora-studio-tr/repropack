import { createServer } from 'node:http';
import { readFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { parseCapsule, InputError } from './core/model.ts';
import { minimize } from './core/minimize.ts';
import { createAdapterRegistry } from './adapters/sessions.ts';
import { Store } from './store.ts';
import type { Run } from './store.ts';
import { Identity } from './auth.ts';
import type { Principal } from './auth.ts';
import { body, HttpError } from './http.ts';
import { mailFromEnvironment } from './mail.ts';
import type { Mailer } from './mail.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
export const example = () => readFile(join(root, 'examples/cart-discount.json'), 'utf8').then(text => parseCapsule(JSON.parse(text)));
export const postgresExample = () => readFile(join(root, 'examples/postgres-cart.json'), 'utf8').then(text => parseCapsule(JSON.parse(text)));
const active = (run: Run) => run.status === 'queued' || run.status === 'running';
/** Authenticated workbench. The listener remains loopback-only; TLS ingress is operator configured. */
export async function createApp(dataDirectory: string, options: { applicationConfig?: string; applicationTeamId?: string; publicOrigin?: string; bootstrapToken?: string; demoMode?: boolean; mailer?: Mailer; requireVerifiedEmail?: boolean } = {}) {
  if (options.demoMode && (options.applicationConfig || options.applicationTeamId || options.bootstrapToken || existsSync(join(dataDirectory, 'runs.sqlite')))) throw new Error('Public demo requires a new disposable directory without operator applications or bootstrap credentials');
  if (options.applicationConfig && (!options.applicationTeamId || !/^[a-f0-9-]{36}$/u.test(options.applicationTeamId))) throw new Error('Bind a custom application to REPROPACK_APP_TEAM_ID');
  const publicOrigin = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  const localHttp = publicOrigin?.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(publicOrigin.hostname);
  if (publicOrigin && ((!localHttp && publicOrigin.protocol !== 'https:') || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash)) throw new Error('REPROPACK_PUBLIC_ORIGIN must be an HTTPS origin (or explicit loopback HTTP) without a path or credentials');
  const demoCapsule = options.demoMode ? await example() : undefined;
  const store = new Store(dataDirectory);
  let identity: Identity;
  try { identity = new Identity(store, dataDirectory, options.bootstrapToken, options.demoMode, options.mailer, options.requireVerifiedEmail); }
  catch (error) { store.close(); throw error; }
  const registries = new Map<string, ReturnType<typeof createAdapterRegistry>>();
  const registryFor = (teamId: string) => {
    let registry = registries.get(teamId);
    if (!registry) {
      registry = createAdapterRegistry(join(dataDirectory, 'teams', teamId), teamId === options.applicationTeamId ? options.applicationConfig : undefined, options.demoMode).catch(error => { registries.delete(teamId); throw error; });
      registries.set(teamId, registry);
    }
    return registry;
  };
  const live = new Map<string, { run: Run; controller: AbortController; maxTrials: number }>();
  const queue: string[] = [];
  const verificationControllers = new Map<AbortController, { userId: string; teamId: string }>();
  const verificationCompletions = new Set<Promise<void>>();
  let pumping: Promise<void> | undefined;
  let stopping = false;
  let sweeping: Promise<void> | undefined;
  function sweepDemo() {
    if (!options.demoMode) return Promise.resolve();
    if (sweeping) return sweeping;
    sweeping = (async () => {
      for (const teamId of identity.expiredDemoTeams()) {
        for (const job of live.values()) if (job.run.teamId === teamId) job.controller.abort(new DOMException('Demo expired', 'AbortError'));
        for (const [controller, actor] of verificationControllers) if (actor.teamId === teamId) controller.abort(new DOMException('Demo expired', 'AbortError'));
        if ([...live.values()].some(job => job.run.teamId === teamId) || [...verificationControllers.values()].some(actor => actor.teamId === teamId)) continue;
        const registry = registries.get(teamId); if (registry) { await (await registry).close(); registries.delete(teamId); }
        identity.deleteDemoTeam(teamId);
      }
    })().finally(() => { sweeping = undefined; });
    return sweeping;
  }
  const cleanupTimer = options.demoMode ? setInterval(() => { void sweepDemo().catch(() => console.error('Demo cleanup could not complete; expired access remains denied.')); }, 15_000).unref() : undefined;
  const queueFull = (person: Principal) => live.size >= 8 || [...live.values()].filter(job => job.run.teamId === person.teamId).length >= 2 || [...live.values()].filter(job => job.run.createdBy === person.userId).length >= 2;
  identity.onAccessChanged = (userId, teamId, force = false) => {
    if (!force && identity.canWrite(userId, teamId)) return;
    for (const job of live.values()) if (job.run.createdBy === userId && job.run.teamId === teamId) job.controller.abort(new DOMException('Team access revoked', 'AbortError'));
    for (const [controller, actor] of verificationControllers) if (actor.userId === userId && actor.teamId === teamId) controller.abort(new DOMException('Team access revoked', 'AbortError'));
  };
  function pump() {
    if (pumping || stopping) return;
    pumping = (async () => {
      while (queue.length && !stopping) {
        const id = queue.shift()!;
        const job = live.get(id);
        if (!job) continue;
        const { run, controller } = job;
        run.status = 'running'; store.save(run);
        try {
          if (!identity.canWrite(run.createdBy, run.teamId)) throw new HttpError(403, 'Team access was revoked before execution');
          const registry = await registryFor(run.teamId);
          const session = await registry.acquire(run.source);
          run.environment = session.evidence;
          run.fixAvailable = session.hasFix;
          run.report = await minimize(run.source.steps, session.execute(), {
            anchorId: run.source.oracle.stepId, maxTrials: job.maxTrials, timeoutMs: session.timeoutMs, signal: controller.signal,
            onEvent(event) { run.events.push(event); },
          });
          run.status = run.report.status;
        } catch (error) {
          run.status = 'failed'; run.error = error instanceof Error ? error.message : 'Reduction failed';
        }
        store.transaction(() => { store.save(run); identity.event(run.teamId, run.createdBy, 'run.finished', run.id, { status: run.status }); });
        live.delete(id);
      }
    })().finally(() => { pumping = undefined; if (queue.length && !stopping) pump(); });
  }
  const find = (id: string, teamId: string) => {
    const running = live.get(id)?.run;
    return running?.teamId === teamId ? running : store.get(id, teamId);
  };
  const server = createServer(async (req, res) => {
    const security = {
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    };
    for (const [key, value] of Object.entries(security)) res.setHeader(key, value);
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const address = server.address();
      const port = address && typeof address !== 'string' ? address.port : 0;
      if (req.method === 'GET' && req.url === '/healthz' && !req.headers.origin && [`127.0.0.1:${port}`, `localhost:${port}`, ...(publicOrigin ? [publicOrigin.host] : [])].includes(req.headers.host ?? '')) { json(stopping ? 503 : 200, { status: stopping ? 'stopping' : 'ok' }); return; }
      const hosts = publicOrigin ? [publicOrigin.host] : [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host ?? '')) throw new HttpError(403, 'Untrusted Host header');
      const allowedOrigins = publicOrigin ? [publicOrigin.origin] : hosts.map(host => `http://${host}`);
      const origin = publicOrigin?.origin ?? `http://${req.headers.host}`;
      if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) throw new HttpError(403, 'Cross-origin requests are not allowed');
      const path = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
      const method = req.method ?? 'GET';
      if (!['GET', 'POST'].includes(method)) throw new HttpError(405, 'Method not supported');
      if (method === 'POST' && (req.headers['x-repropack-local'] !== '1' || !req.headers.origin || !allowedOrigins.includes(req.headers.origin))) throw new HttpError(403, 'A same-origin request is required');
      if (stopping) throw new HttpError(503, 'Server is shutting down');
      if (options.demoMode && ['/api/session', '/api/demo/session'].includes(path)) await sweepDemo();
      if (await identity.route(req, res, origin, path, method, json)) return;
      const person = path.startsWith('/api/') ? identity.require(req, origin, method === 'POST') : undefined;
      if (path.startsWith('/api/')) {
        res.setHeader('vary', 'Cookie');
      }
      if (person) { identity.fresh(person); identity.requireVerified(person); }
      const registry = person && ['/api/runtime', '/api/runs'].includes(path) ? await registryFor(person.teamId) : undefined;
      if (method === 'GET' && path === '/api/runtime') { json(200, registry!.runtimeInfo); return; }
      if (method === 'GET' && path === '/api/example') { json(200, await example()); return; }
      if (method === 'GET' && path === '/api/examples/postgres') { if (options.demoMode) throw new HttpError(403, 'Only the synthetic HTTP example is available in the public demo'); json(200, await postgresExample()); return; }
      if (method === 'GET' && path === '/api/runs') {
        const rows = store.list(person!.teamId).map(row => ({ ...row, status: live.get(row.id)?.run.status ?? row.status }));
        json(200, rows); return;
      }
      if (method === 'POST' && path === '/api/runs') {
        identity.fresh(person!, 'write');
        if (queueFull(person!)) throw new HttpError(429, 'The replay queue is full');
        const input = await body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Expected a JSON object');
        const { capsule, maxTrials = 160 } = input as Record<string, unknown>;
        if (Object.keys(input).some(key => !['capsule', 'maxTrials'].includes(key))) throw new InputError('Unsupported request field');
        if (!Number.isInteger(maxTrials) || (maxTrials as number) < 6 || (maxTrials as number) > 500) throw new InputError('maxTrials must be an integer between 6 and 500');
        identity.fresh(person!, 'write');
        const source = parseCapsule(capsule); registry!.supports(source);
        if (options.demoMode && (!isDeepStrictEqual(source, demoCapsule) || (maxTrials as number) > 160)) throw new HttpError(400, 'The public demo only runs the unchanged bundled HTTP scenario, up to 160 trials');
        if (queueFull(person!)) throw new HttpError(429, 'The replay queue is full');
        const run: Run = { id: randomUUID(), teamId: person!.teamId, createdBy: person!.userId, createdAt: new Date().toISOString(), status: 'queued', source, events: [] };
        store.transaction(() => { identity.consumeDemoOperation(run.teamId); store.save(run); identity.event(run.teamId, run.createdBy, 'run.created', run.id); });
        live.set(run.id, { run, controller: new AbortController(), maxTrials: maxTrials as number }); queue.push(run.id);
        json(202, { id: run.id }); pump(); return;
      }
      const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(capsule|report|cancel|verify))?$/u.exec(path);
      if (match) {
        const id = match[1]!;
        const operation = match[2];
        const run = find(id, person!.teamId);
        if (!run) throw new HttpError(404, 'Run not found');
        if (method === 'GET' && !operation) { json(200, run); return; }
        if (method === 'GET' && (operation === 'capsule' || operation === 'report')) {
          if (!run.report?.finalVerified || run.report.status !== 'completed') throw new HttpError(409, 'Only completed, freshly verified reductions can be exported');
          res.setHeader('content-disposition', `attachment; filename="repropack-${operation}-${id}.json"`);
          identity.event(person!.teamId, person!.userId, 'run.exported', id, { format: operation });
          json(200, operation === 'report' ? { ...run.report, environment: run.environment ?? null, verification: run.verification ?? null } : { ...run.source, steps: run.source.steps.filter(step => run.report!.reducedStepIds.includes(step.id)) }); return;
        }
        if (method === 'POST' && operation === 'cancel') {
          identity.fresh(person!, 'write');
          const job = live.get(id);
          if (!job) throw new HttpError(409, 'This run is no longer active');
          job.controller.abort(new DOMException('Cancelled', 'AbortError'));
          if (job.run.status === 'queued') { job.run.status = 'cancelled'; store.save(job.run); live.delete(id); }
          identity.event(person!.teamId, person!.userId, 'run.cancelled', id);
          json(200, { cancelled: true }); return;
        }
        if (method === 'POST' && operation === 'verify') {
          identity.fresh(person!, 'write');
          if (run.status !== 'completed' || !run.report?.finalVerified) throw new HttpError(409, 'Complete a reduction first');
          if (verificationControllers.size) throw new HttpError(409, 'A fix check is already running');
          if (options.demoMode) store.transaction(() => identity.consumeDemoOperation(person!.teamId));
          const controller = new AbortController(); verificationControllers.set(controller, { userId: person!.userId, teamId: person!.teamId });
          let finish!: () => void;
          const completion = new Promise<void>(resolve => { finish = resolve; });
          verificationCompletions.add(completion);
          try {
            const registry = await registryFor(person!.teamId);
            const session = await registry.acquire(run.source);
            identity.fresh(person!, 'write');
            if (!session.hasFix) throw new HttpError(409, 'No fixedModule is registered for this application');
            if (run.source.adapter === 'node-http-postgres' && session.evidence.snapshotSha256 !== run.environment?.snapshotSha256) throw new HttpError(409, 'The snapshot changed after this run. Start a fresh reduction before checking a fix.');
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(run.source.adapter === 'demo-cart' ? 15_000 : 45_000)]);
            const execute = session.execute(true);
            const steps = run.source.steps.filter(step => run.report!.reducedStepIds.includes(step.id));
            let passed = true;
            for (let i = 0; i < 3; i++) if ((await execute(steps, signal)).verdict !== 'pass') passed = false;
            run.verification = { passed, attempts: 3, adapter: run.source.adapter === 'demo-cart' ? 'demo-cart-fixed' : 'configured-node-module', checkedAt: new Date().toISOString(), reason: passed ? 'The expected success signature was observed in all three fresh runs of the registered fixed application.' : 'The expected success signature was not stable.' };
            identity.fresh(person!, 'write');
            store.transaction(() => { store.save(run); identity.event(person!.teamId, person!.userId, 'run.fix_checked', id, { passed }); });
            json(200, run.verification); return;
          } finally { verificationControllers.delete(controller); finish(); verificationCompletions.delete(completion); }
        }
        throw new HttpError(405, 'Method not supported for this operation');
      }
      if (path.startsWith('/api/')) throw new HttpError(404, 'API route not found');
      const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const file = files[path];
      if (method !== 'GET' || !file) throw new HttpError(404, 'Page not found');
      let content: Buffer;
      try { content = await readFile(join(root, 'dist', file[0])); }
      catch { throw new HttpError(503, 'Build the interface first with npm run build'); }
      res.writeHead(200, { 'content-type': file[1] }); res.end(content);
    } catch (error) {
      if (!res.headersSent) json(error instanceof HttpError ? error.status : error instanceof InputError ? 400 : 500, { error: error instanceof InputError || error instanceof HttpError ? error.message : 'The local server could not complete the request.' });
      else res.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  if (options.demoMode) server.maxConnections = 64;
  return {
    server,
    bootstrapPath: identity.bootstrapPath,
    async dispose() {
      stopping = true;
      clearInterval(cleanupTimer);
      for (const { controller } of live.values()) controller.abort(new DOMException('Shutdown', 'AbortError'));
      for (const controller of verificationControllers.keys()) controller.abort(new DOMException('Shutdown', 'AbortError'));
      await pumping;
      await Promise.allSettled([...verificationCompletions]);
      await sweeping;
      await identity.settleEmail();
      const opened = await Promise.allSettled([...registries.values()]);
      const cleanups = await Promise.allSettled(opened.filter(result => result.status === 'fulfilled').map(result => result.value.close()));
      for (const { run } of live.values()) { run.status = 'interrupted'; store.save(run); }
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
      options.mailer?.close?.();
      const failed = cleanups.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
async function main() {
  const port = Number(process.env.PORT ?? process.env.REPROPACK_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid REPROPACK_PORT');
  const host = process.env.REPROPACK_LISTEN_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('REPROPACK_LISTEN_HOST must be 127.0.0.1 or 0.0.0.0');
  const demoMode = process.env.REPROPACK_DEMO === '1';
  const mailer = demoMode ? undefined : mailFromEnvironment();
  if (process.env.REPROPACK_REQUIRE_VERIFIED_EMAIL && !['0', '1'].includes(process.env.REPROPACK_REQUIRE_VERIFIED_EMAIL)) throw new Error('REPROPACK_REQUIRE_VERIFIED_EMAIL must be 0 or 1');
  if (process.env.REPROPACK_DEMO && !['0', '1'].includes(process.env.REPROPACK_DEMO)) throw new Error('REPROPACK_DEMO must be 0 or 1');
  const lifetime = Number(process.env.REPROPACK_DEMO_LIFETIME_MS ?? 0);
  if (!Number.isInteger(lifetime) || (lifetime !== 0 && (!demoMode || lifetime < 60_000 || lifetime > 7_200_000))) throw new Error('Demo lifetime must be 60 seconds to two hours, or zero for no instance deadline');
  const origin = process.env.REPROPACK_PUBLIC_ORIGIN || (demoMode && process.env.REPROPACK_PLATFORM === 'render' ? process.env.RENDER_EXTERNAL_URL : undefined);
  if (demoMode && process.env.REPROPACK_PLATFORM === 'render' && !origin) throw new Error('Render must provide RENDER_EXTERNAL_URL for the public demo origin');
  const temporaryRoot = await realpath(tmpdir()); const owner = randomUUID();
  const directory = demoMode ? await mkdtemp(join(temporaryRoot, 'repropack-demo-')) : resolve(process.env.REPROPACK_DATA_DIR || join(root, '.repropack'));
  if (demoMode) await writeFile(join(directory, '.repropack-demo-owned'), owner, { flag: 'wx', mode: 0o600 });
  const cleanDemo = async () => {
    if (!demoMode) return;
    const canonical = await realpath(directory);
    if (dirname(canonical) !== temporaryRoot || !basename(canonical).startsWith('repropack-demo-') || await readFile(join(canonical, '.repropack-demo-owned'), 'utf8') !== owner) throw new Error('Refusing to remove a directory without exact demo ownership');
    await rm(canonical, { recursive: true, force: true });
  };
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp(directory, {
    ...(process.env.REPROPACK_APP_CONFIG ? { applicationConfig: process.env.REPROPACK_APP_CONFIG } : {}),
    ...(process.env.REPROPACK_APP_TEAM_ID ? { applicationTeamId: process.env.REPROPACK_APP_TEAM_ID } : {}),
    ...(origin ? { publicOrigin: origin } : {}), demoMode,
    ...(mailer ? { mailer } : {}), requireVerifiedEmail: !demoMode && process.env.REPROPACK_REQUIRE_VERIFIED_EMAIL === '1',
    });
    app.server.listen(port, host);
    await once(app.server, 'listening');
  } catch (error) { await app?.dispose(); await cleanDemo(); throw error; }
  const running = app;
  console.log(demoMode ? `ReproPack disposable demo: ${origin ?? `http://127.0.0.1:${port}`}\nOnly the synthetic HTTP fixture is enabled. Sessions expire after 60 minutes.` : `ReproPack authenticated alpha: ${origin ?? `http://127.0.0.1:${port}`}\nFirst setup uses the private key at: ${running.bootstrapPath}`);
  let closing = false;
  const shutdown = () => { if (closing) return; closing = true; void running.dispose().then(cleanDemo).then(() => process.exit(0)).catch(() => { console.error('Shutdown cleanup did not complete.'); process.exit(1); }); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  if (lifetime) setTimeout(shutdown, lifetime).unref();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
