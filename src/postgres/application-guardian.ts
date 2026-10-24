import { fork } from 'node:child_process';
import type { Serializable } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const child = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [], { windowsHide: true, execArgv: [], env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const exited = once(child, 'exit'); void exited.catch(() => undefined);
let closing = false;
async function close() {
  if (closing) return; closing = true; clearTimeout(watchdog);
  if (child.connected) child.send({ type: 'stop' }, () => undefined);
  // Outside application code: an infinite JS loop cannot block this deadline.
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1000);
  await exited.catch(() => undefined); clearTimeout(timer);
  if (process.connected) process.disconnect();
}
const watchdog = setTimeout(() => { void close(); }, 15_000);
child.on('message', message => { if (process.connected) process.send?.(message); });
child.on('exit', () => { clearTimeout(watchdog); if (process.connected) process.disconnect(); });
process.on('disconnect', () => { void close(); });
process.on('message', (message: Serializable) => {
  if ((message as { type?: string })?.type === 'stop') void close();
  else if (child.connected) child.send(message, () => undefined);
});
