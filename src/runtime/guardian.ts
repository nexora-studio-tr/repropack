import { fork } from 'node:child_process';
import type { Serializable } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

/** This supervisor never imports application code; IPC loss survives a workbench crash. */
export function guardian(script: URL, extraEnvironment: string[] = []) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', ...extraEnvironment]) if (process.env[key]) env[key] = process.env[key];
  // Windows otherwise puts the supervisor in the workbench's kill-on-close Job Object.
  const child = fork(fileURLToPath(script), [], { detached: true, windowsHide: true, execArgv: [], env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit').then(() => undefined);
  void exited.catch(() => undefined);
  const send = (message: Serializable) => { if (child.connected) child.send(message, () => undefined); };
  return { child, exited, send };
}
