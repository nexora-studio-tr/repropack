import { createServer } from 'node:http';
import pg from 'pg';
let creations = 0;
export async function createApplication({ databaseUrl }: { databaseUrl: string }) {
  const creationCount = ++creations;
  const connection = new pg.Client({ connectionString: databaseUrl }); await connection.connect();
  const permissions = (await connection.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0]!;
  let canCreateTable = true;
  try { await connection.query('CREATE TABLE public.forbidden(id integer)'); }
  catch { canCreateTable = false; }
  const other = new URL(databaseUrl); other.pathname = '/postgres';
  const outside = new pg.Client({ connectionString: other.href, connectionTimeoutMillis: 2000 });
  let canConnectOtherDatabase = true;
  try { await outside.connect(); }
  catch { canConnectOtherDatabase = false; }
  finally { await outside.end().catch(() => undefined); }
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ creationCount, ...permissions, canCreateTable, canConnectOtherDatabase, inheritedSecret: Boolean(process.env.REPROPACK_TEST_SECRET) }));
  });
  return { server, async dispose() { await connection.end(); } };
}
