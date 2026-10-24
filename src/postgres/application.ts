import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function launchApplication(module: string, databaseUrl: string, signal: AbortSignal, expectedHash?: string) {
  signal.throwIfAborted();
  const hash = expectedHash ?? createHash('sha256').update(await readFile(module)).digest('hex');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const child = fork(fileURLToPath(new URL('./application-guardian.ts', import.meta.url)), [], { detached: true, windowsHide: true, execArgv: [], env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  let closed = false;
  async function close() {
    if (closed) return; closed = true;
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'stop' }, () => undefined);
      const graceful = await Promise.race([exited.then(() => true), delay(3000, undefined, { ref: false }).then(() => false)]);
      if (!graceful) { child.kill(); await exited; }
    }
  }
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Application startup exceeded 10 seconds')), 10_000);
      const abort = () => reject(signal.reason);
      const fail = () => reject(new Error('Application exited before becoming ready'));
      const message = (raw: unknown) => {
        const value = raw as { type?: string; origin?: string; message?: string };
        if (value.type === 'ready' && value.origin) resolve(value.origin);
        if (value.type === 'error') reject(new Error(value.message ?? 'Application startup failed'));
      };
      child.once('error', reject); child.once('exit', fail); child.on('message', message); signal.addEventListener('abort', abort, { once: true });
      const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); child.removeListener('message', message); child.removeListener('exit', fail); child.removeListener('error', reject); };
      child.once('message', raw => { const value = raw as { type?: string }; if (value.type === 'ready' || value.type === 'error') clean(); });
      exited.finally(clean).catch(() => undefined);
      child.send({ module, databaseUrl, expectedHash: hash }, error => { if (error) reject(error); });
    });
    return { origin, close };
  } catch (error) { await close(); throw error; }
}
