import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';

interface Application { server: Server; dispose(): Promise<void> }
let application: Application | undefined;
let closing = false;
async function close() {
  if (closing) return; closing = true;
  if (application) {
    application.server.closeAllConnections();
    if (application.server.listening) await new Promise<void>(resolve => application!.server.close(() => resolve()));
    await application.dispose();
  }
  process.exit(0);
}
process.on('disconnect', () => { void close(); });
process.on('message', message => {
  if ((message as { type?: string })?.type === 'stop') void close();
});
process.once('message', async raw => {
  const input = raw as { module: string; databaseUrl: string; expectedHash: string };
  try {
    if (createHash('sha256').update(await readFile(input.module)).digest('hex') !== input.expectedHash) throw new Error('Application entry module changed after preparation');
    const loaded = await import(pathToFileURL(input.module).href) as { createApplication(context: { databaseUrl: string }): Promise<Application> };
    if (typeof loaded.createApplication !== 'function') throw new Error('Module must export createApplication({ databaseUrl })');
    application = await loaded.createApplication({ databaseUrl: input.databaseUrl });
    if (application.server.listening || typeof application.dispose !== 'function') throw new Error('Factory must return a non-listening server and dispose()');
    if (closing) { await application.dispose(); return; }
    application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening');
    const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('Application failed to bind');
    if (process.connected) process.send?.({ type: 'ready', origin: `http://127.0.0.1:${address.port}` });
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'Application startup failed').replace(/postgres(?:ql)?:\/\/\S+/gu, '[database URL removed]');
    if (process.connected) process.send?.({ type: 'error', message });
    await close();
  }
});
