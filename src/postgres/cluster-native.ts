import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const exec = promisify(execFile);
export const quote = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';
export const qualified = (table: string) => table.split('.').map(quote).join('.');
export const name = (prefix: string) => `rp_${prefix}_${randomBytes(8).toString('hex')}`;
export function client(url: string) {
  return new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000, query_timeout: 10_000, statement_timeout: 8000 });
}
export function databaseUrl(base: string, database: string, user?: string, password?: string) {
  const url = new URL(base); url.pathname = `/${database}`;
  if (user !== undefined) url.username = user;
  if (password !== undefined) url.password = password;
  return url.toString();
}
export interface Cluster { adminUrl: string; version: string; directory: string; close(): Promise<void> }

/** Starts an owned native PostgreSQL process; no service, system user or existing cluster is modified. */
export async function createNativeCluster(parent: string): Promise<Cluster> {
  if (process.getuid?.() === 0) throw new Error('Run PostgreSQL as an unprivileged user. ReproPack will not create system users.');
  await mkdir(parent, { recursive: true });
  const boundary = await realpath(parent);
  const directory = await mkdtemp(join(boundary, 'cluster-'));
  const marker = randomUUID();
  await writeFile(join(directory, '.repropack-owned'), marker, { mode: 0o600 });
  let binaries: { initdb: string; postgres: string; pg_ctl: string } | undefined;
  const password = randomBytes(24).toString('hex');
  const passwordFile = join(directory, 'init-password');
  const data = join(directory, 'data');
  let child: ReturnType<typeof spawn> | undefined;
  let closed = false;
  let logs = '';
  async function cleanup() {
    if (closed) return; closed = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { await exec(binaries!.pg_ctl, ['stop', '-D', data, '-m', 'fast', '-w', '-t', '10'], { windowsHide: true, timeout: 15_000 }); }
      catch { await exec(binaries!.pg_ctl, ['stop', '-D', data, '-m', 'immediate', '-w', '-t', '5'], { windowsHide: true, timeout: 8000 }); }
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    }
    const actual = await realpath(directory);
    const within = relative(boundary, actual);
    if (!within || within.startsWith('..') || isAbsolute(within) || await readFile(join(actual, '.repropack-owned'), 'utf8') !== marker) throw new Error('Refusing to remove an unowned cluster directory');
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  try {
    binaries = await import(`@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`) as typeof binaries;
    if (!binaries) throw new Error('Native PostgreSQL binaries are unavailable');
    const reservation = createServer();
    const listening = once(reservation, 'listening'); reservation.listen(0, '127.0.0.1'); await listening;
    const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('Could not reserve a PostgreSQL port');
    const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
    await writeFile(passwordFile, password + '\n', { mode: 0o600 });
    await exec(binaries.initdb, ['-D', data, '--username=repropack', `--pwfile=${passwordFile}`, '--auth=scram-sha-256', '--no-locale', '--encoding=UTF8'], { windowsHide: true, timeout: 30_000 });
    await rm(passwordFile, { force: true });
    child = spawn(binaries.postgres, ['-D', data, '-p', String(port), '-h', '127.0.0.1', '-c', 'max_connections=30', '-c', 'shared_buffers=32MB', '-c', 'unix_socket_directories='], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.stderr?.on('data', chunk => { logs = (logs + String(chunk)).slice(-4000); });
    const adminUrl = `postgresql://repropack:${password}@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Owned PostgreSQL exited during startup: ${logs}`);
      const connection = client(adminUrl);
      try {
        await connection.connect();
        await connection.query('REVOKE ALL ON DATABASE postgres, template0, template1 FROM PUBLIC');
        const result = await connection.query<{ version: string }>('SELECT version()');
        await connection.end();
        return { adminUrl, version: result.rows[0]!.version, directory, close: cleanup };
      } catch { await connection.end().catch(() => undefined); await delay(100); }
    }
    throw new Error(`Owned PostgreSQL did not become ready: ${logs}`);
  } catch (error) { await cleanup(); throw error; }
}
