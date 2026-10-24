import { createServer } from 'node:http';
import { once } from 'node:events';

/** A disposable, loopback-only fixture. This is process-local test state, not a security sandbox. */
export async function createDemoCart(fixed = false) {
  let created = false, quantity = 0, coupon: string | null = null, total = 0;
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      let text = '';
      for await (const chunk of req) { text += chunk; if (text.length > 65_536) { send(413, { error: 'body_too_large' }); return; } }
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const method = req.method;
      if (method === 'GET' && path === '/health') { send(200, { healthy: true }); return; }
      if (method === 'GET' && path === '/catalog') { send(200, { sku: 'coffee', price: 50 }); return; }
      if (path === '/preferences') { send(200, { theme: 'system' }); return; }
      if (method === 'POST' && path === '/cart') { created = true; quantity = 0; coupon = null; total = 0; send(201, { created }); return; }
      if (!created) { send(409, { error: 'cart_missing' }); return; }
      if (method === 'POST' && path === '/cart/items') {
        if (body.sku !== 'coffee' || !Number.isInteger(body.quantity) || (body.quantity as number) < 1 || (body.quantity as number) > 100) { send(400, { error: 'invalid_item' }); return; }
        quantity = body.quantity as number; total = quantity * 50; send(201, { quantity, total }); return;
      }
      if (method === 'POST' && path === '/cart/coupon') {
        if (!quantity || body.code !== 'SAVE20') { send(400, { error: 'invalid_coupon' }); return; }
        coupon = 'SAVE20'; total = quantity * 50 * 0.8; send(200, { coupon, total }); return;
      }
      if (method === 'PATCH' && path === '/cart/items/coffee') {
        if (!quantity || !Number.isInteger(body.quantity) || (body.quantity as number) < 1 || (body.quantity as number) > 100) { send(400, { error: 'invalid_quantity' }); return; }
        quantity = body.quantity as number;
        // Intentional fixture bug: changing quantity drops the discount but retains the coupon.
        total = quantity * 50 * (fixed && coupon ? 0.8 : 1);
        send(200, { quantity, coupon, total }); return;
      }
      if (method === 'GET' && (path === '/cart' || path === '/cart/checkout')) { send(200, { quantity, coupon, total, currency: 'USD' }); return; }
      send(404, { error: 'route_missing' });
    } catch { send(400, { error: 'invalid_json' }); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to listen');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async dispose() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
