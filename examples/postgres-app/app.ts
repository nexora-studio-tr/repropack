import { createServer } from 'node:http';
import pg from 'pg';

export async function buildApplication({ databaseUrl }: { databaseUrl: string }, fixed = false) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const recalculate = async (connection: pg.PoolClient, honorCoupon: boolean) => {
    await connection.query(`UPDATE public.carts SET total_cents = COALESCE((SELECT SUM(i.quantity*p.price_cents) FROM public.cart_items i JOIN public.products p ON p.sku=i.product_sku WHERE i.cart_id=42),0) * CASE WHEN $1 AND coupon='SAVE20' THEN 80 ELSE 100 END / 100 WHERE id=42`, [honorCoupon]);
  };
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      let text = '';
      for await (const chunk of req) { text += chunk; if (text.length > 65_536) { send(413, { error: 'body_too_large' }); return; } }
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const method = req.method;
      if (method === 'GET' && path === '/health') { await pool.query('SELECT 1'); send(200, { healthy: true }); return; }
      if (method === 'GET' && path === '/catalog') { send(200, (await pool.query('SELECT sku,price_cents FROM public.products ORDER BY sku')).rows); return; }
      if (path === '/preferences') { send(200, { theme: 'system' }); return; }
      if (method === 'GET' && (path === '/cart' || path === '/cart/checkout')) {
        const row = (await pool.query<{ coupon: string | null; total: number; quantity: string }>(`SELECT c.coupon,c.total_cents/100 AS total,COALESCE(SUM(i.quantity),0)::text AS quantity FROM public.carts c LEFT JOIN public.cart_items i ON i.cart_id=c.id WHERE c.id=42 GROUP BY c.id`)).rows[0];
        if (!row) { send(404, { error: 'cart_missing' }); return; }
        send(200, { ...row, quantity: Number(row.quantity), currency: 'USD' }); return;
      }
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        let status = 200;
        if (method === 'POST' && path === '/cart') {
          await connection.query('DELETE FROM public.cart_items WHERE cart_id=42');
          await connection.query("UPDATE public.carts SET coupon=NULL,total_cents=0 WHERE id=42"); status = 201;
        } else if (method === 'POST' && path === '/cart/items') {
          if (body.sku !== 'coffee' || !Number.isInteger(body.quantity) || (body.quantity as number) < 1 || (body.quantity as number) > 100) { await connection.query('ROLLBACK'); send(400, { error: 'invalid_item' }); return; }
          await connection.query('INSERT INTO public.cart_items VALUES (42,$1,$2) ON CONFLICT(cart_id,product_sku) DO UPDATE SET quantity=excluded.quantity', [body.sku, body.quantity]);
          await recalculate(connection, true); status = 201;
        } else if (method === 'POST' && path === '/cart/coupon') {
          if (body.code !== 'SAVE20') { await connection.query('ROLLBACK'); send(400, { error: 'invalid_coupon' }); return; }
          await connection.query("UPDATE public.carts SET coupon='SAVE20' WHERE id=42"); await recalculate(connection, true);
        } else if (method === 'PATCH' && path === '/cart/items/coffee') {
          if (!Number.isInteger(body.quantity) || (body.quantity as number) < 1 || (body.quantity as number) > 100) { await connection.query('ROLLBACK'); send(400, { error: 'invalid_quantity' }); return; }
          await connection.query("UPDATE public.cart_items SET quantity=$1 WHERE cart_id=42 AND product_sku='coffee'", [body.quantity]);
          // Deliberate sample bug: the normal module drops the discount when quantity changes.
          await recalculate(connection, fixed);
        } else { await connection.query('ROLLBACK'); send(404, { error: 'route_missing' }); return; }
        await connection.query('COMMIT'); send(status, { accepted: true });
      } catch { await connection.query('ROLLBACK'); send(500, { error: 'database_operation_failed' }); }
      finally { connection.release(); }
    } catch { send(400, { error: 'request_failed' }); }
  });
  return { server, async dispose() { await pool.end(); } };
}
export const createApplication = (context: { databaseUrl: string }) => buildApplication(context);
