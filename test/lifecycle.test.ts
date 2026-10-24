import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

async function waitFor(check: () => Promise<boolean>, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await delay(75); }
  assert.fail('Owned resources did not close after their workbench was killed');
}
const absent = (path: string) => access(path).then(() => false, () => true);
async function connected(port: number) {
  return await new Promise<boolean>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(300, () => done(false));
  });
}
function parent(directory: string, mode = '') {
  return fork(fileURLToPath(new URL('./fixtures/crash-parent.ts', import.meta.url)), [directory, mode], { windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}
test('hard-killing a real workbench closes PostgreSQL and an application stuck in an infinite loop', { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rp-crash-'));
  const process = parent(directory); const exited = once(process, 'exit');
  try {
    const [ready] = await once(process, 'message') as [{ directory: string; postgresPort: number; origin: string }];
    await assert.rejects(fetch(`${ready.origin}/block`, { signal: AbortSignal.timeout(200) }));
    assert.equal(await connected(ready.postgresPort), true);
    process.kill('SIGKILL'); await exited;
    await waitFor(async () => await absent(ready.directory) && !await connected(ready.postgresPort) && !await connected(Number(new URL(ready.origin).port)));
  } finally { if (process.exitCode === null && process.signalCode === null) { process.kill('SIGKILL'); await exited; } await rm(directory, { recursive: true, force: true }); }
});
test('workbench loss while native initdb is starting leaves no owned cluster directory', { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rp-startup-crash-'));
  const process = parent(directory, 'starting'); const exited = once(process, 'exit');
  try {
    await waitFor(async () => (await readdir(join(directory, 'postgres')).catch(() => [])).some(file => file.startsWith('cluster-')));
    process.kill('SIGKILL'); await exited;
    await waitFor(async () => (await readdir(join(directory, 'postgres'))).length === 0);
  } finally { if (process.exitCode === null && process.signalCode === null) { process.kill('SIGKILL'); await exited; } await rm(directory, { recursive: true, force: true }); }
});
