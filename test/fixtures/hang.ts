import { createServer } from 'node:http';
export async function createApplication() {
  const server = createServer((req, res) => { if (req.url === '/block') { while (true) { /* deliberate stuck application */ } } res.end('{}'); });
  return { server, async dispose() { while (true) { /* deliberate stuck cleanup */ } } };
}
