import { createServer } from 'node:http';
import { writeFile, access, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';

export async function createApplication() {
  const server = createServer(async (req, res) => {
    if (req.url === '/spin') { while (true) { /* quota test; deliberately uncooperative */ } }
    const rootWriteDenied = await writeFile('/opt/repropack/forbidden-write', 'probe').then(() => false, () => true);
    const socketDenied = await access('/var/run/docker.sock').then(() => false, () => true);
    const networkDenied = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: '198.51.100.1', port: 443 });
      const done = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.once('connect', () => done(false)); socket.once('error', () => done(true)); socket.setTimeout(300, () => done(true));
    });
    const noExternalInterface = Object.keys(networkInterfaces()).every(key => key === 'lo');
    const rootReadOnly = (await readFile('/proc/mounts', 'utf8')).split('\n').some(line => { const fields = line.split(' '); return fields[1] === '/' && fields[3]?.split(',').includes('ro'); });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ rootWriteDenied, rootReadOnly, socketDenied, networkDenied, noExternalInterface, hostSecret: Boolean(process.env.REPROPACK_HOST_SECRET) }));
  });
  return { server, async dispose() {} };
}
