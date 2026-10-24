import type { Client } from 'pg';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { quote, qualified } from './cluster.ts';
import type { SnapshotSpec } from './config.ts';

export type Row = Record<string, unknown>;
export interface Table { name: string; columns: string[]; types: string[]; primaryKey: string[]; identities: string[] }
export interface ForeignKey { name: string; child: string; parent: string; columns: string[]; parentColumns: string[]; deferred: boolean }
export interface Snapshot {
  id: string;
  tables: Table[];
  foreignKeys: ForeignKey[];
  rows: Record<string, Row[]>;
  rowCounts: Record<string, number>;
  totalRows: number;
  redactedCells: number;
  sha256: string;
}
const rowKey = (row: Row, columns: string[]) => JSON.stringify(columns.map(column => row[column]));

/** A consistent, read-only source transaction. Descendants are opt-in; required parents are closed transitively. */
export async function captureSnapshot(source: Client, spec: SnapshotSpec): Promise<Snapshot> {
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await source.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; SET LOCAL TIME ZONE 'UTC'");
    const metadata = await source.query<{ name: string; columns: string[]; types: string[]; primaryKey: string[]; identities: string[]; rls: boolean }>(`
      SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity AS rls,
        ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum) AS columns,
        ARRAY(SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum) AS types,
        ARRAY(SELECT a.attname::text FROM pg_constraint p CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num WHERE p.conrelid=c.oid AND p.contype='p' ORDER BY k.ord) AS "primaryKey",
        ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND (a.attidentity<>'' OR pg_get_serial_sequence(n.nspname || '.' || c.relname,a.attname) IS NOT NULL) ORDER BY a.attnum) AS identities
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname || '.' || c.relname = ANY($1::text[]) AND c.relkind='r' AND NOT c.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) ORDER BY 1`, [spec.tables]);
    const tables = metadata.rows;
    if (tables.length !== spec.tables.length) throw new Error('Snapshot tables must exist and be ordinary PostgreSQL tables; views, partitions and inheritance are unsupported');
    for (const table of tables) {
      if (table.rls || !table.primaryKey.length || table.columns.length > 64 || table.primaryKey.some(column => !table.columns.includes(column))) throw new Error(`Table ${table.name} needs a non-generated primary key, at most 64 insertable columns, and no RLS`);
    }
    const foreignKeys = (await source.query<ForeignKey>(`
      SELECT con.conname AS name, ns.nspname || '.' || c.relname AS child, pn.nspname || '.' || p.relname AS parent,
        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY k.ord) AS columns,
        ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=k.num ORDER BY k.ord) AS "parentColumns",
        con.condeferrable AS deferred
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
      JOIN pg_class p ON p.oid=con.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
      WHERE con.contype='f' AND ns.nspname || '.' || c.relname = ANY($1::text[]) ORDER BY 2,1`, [spec.tables])).rows;
    for (const fk of foreignKeys) if (!spec.tables.includes(fk.parent)) throw new Error(`Foreign key ${fk.name} requires allowlisting parent ${fk.parent}`);
    const selected = new Map(tables.map(table => [table.name, new Map<string, Row>()]));
    const byName = new Map(tables.map(table => [table.name, table]));
    let totalRows = 0, bytes = 0;
    function collect(tableName: string, rows: Row[]) {
      const table = byName.get(tableName)!; const target = selected.get(tableName)!;
      for (const row of rows) {
        const key = rowKey(row, table.primaryKey);
        if (target.has(key)) continue;
        totalRows++; bytes += Buffer.byteLength(JSON.stringify(row));
        if (totalRows > spec.maxRows || bytes > 2_097_152) throw new Error('Snapshot row/byte budget exceeded; select a smaller root or descendant scope');
        target.set(key, row);
      }
    }
    async function select(tableName: string, columns: string[], tuples: unknown[][]) {
      const table = byName.get(tableName)!;
      let found = 0;
      if (columns.some(column => !table.columns.includes(column))) throw new Error(`Unknown or generated selector column in ${tableName}`);
      for (let offset = 0; offset < tuples.length; offset += 100) {
        const values: unknown[] = [];
        const conditions = tuples.slice(offset, offset + 100).map(tuple => '(' + columns.map((column, i) => { values.push(tuple[i]); return `${quote(column)} IS NOT DISTINCT FROM $${values.length}`; }).join(' AND ') + ')');
        values.push(spec.maxRows + 1);
        const rows = (await source.query<Row>(`SELECT ${table.columns.map(quote).join(',')} FROM ${qualified(tableName)} WHERE ${conditions.join(' OR ')} ORDER BY ${table.primaryKey.map(quote).join(',')} LIMIT $${values.length}`, values)).rows;
        collect(tableName, rows);
        found += rows.length;
      }
      return found;
    }
    for (const root of spec.roots) {
      if (!await select(root.table, Object.keys(root.where), [Object.values(root.where)])) throw new Error(`Root selection found no rows in ${root.table}`);
    }
    const visited = new Map<string, Set<string>>();
    let changed = true;
    while (changed) {
      const previous = totalRows;
      for (const [index, fk] of foreignKeys.entries()) {
        for (const direction of ['parents', 'children'] as const) {
          if (direction === 'children' && !spec.childrenOf.includes(fk.parent)) continue;
          const from = direction === 'parents' ? fk.child : fk.parent;
          const to = direction === 'parents' ? fk.parent : fk.child;
          const fromColumns = direction === 'parents' ? fk.columns : fk.parentColumns;
          const toColumns = direction === 'parents' ? fk.parentColumns : fk.columns;
          const edge = `${index}:${direction}`;
          const seen = visited.get(edge) ?? new Set<string>(); visited.set(edge, seen);
          const tuples: unknown[][] = [];
          for (const row of selected.get(from)!.values()) {
            const tuple = fromColumns.map(column => row[column]);
            if (tuple.some(value => value === null || value === undefined)) continue;
            const key = JSON.stringify(tuple); if (seen.has(key)) continue;
            seen.add(key); tuples.push(tuple);
          }
          if (tuples.length) await select(to, toColumns, tuples);
        }
      }
      changed = previous !== totalRows;
    }
    const salt = randomBytes(32);
    let redactedCells = 0;
    for (const rule of spec.redact) {
      const table = byName.get(rule.table)!;
      const index = table.columns.indexOf(rule.column);
      if (index < 0 || table.types[index] !== 'text' || table.primaryKey.includes(rule.column) || foreignKeys.some(fk => (fk.child === rule.table && fk.columns.includes(rule.column)) || (fk.parent === rule.table && fk.parentColumns.includes(rule.column)))) throw new Error('Redaction currently requires a non-key TEXT column; PK/FK redaction is unsupported');
      for (const row of selected.get(rule.table)!.values()) {
        if (row[rule.column] === null) continue;
        if (typeof row[rule.column] !== 'string') throw new Error('Redaction expected text');
        const hash = createHmac('sha256', salt).update(row[rule.column] as string).digest('hex');
        row[rule.column] = rule.kind === 'email' ? `masked-${hash}@example.invalid` : `masked-${hash}`;
        redactedCells++;
      }
    }
    const rows = Object.fromEntries(tables.map(table => [table.name, [...selected.get(table.name)!.values()].sort((a, b) => rowKey(a, table.primaryKey).localeCompare(rowKey(b, table.primaryKey)))]));
    const rowCounts = Object.fromEntries(tables.map(table => [table.name, rows[table.name]!.length]));
    const sha256 = createHash('sha256').update(JSON.stringify({ tables, foreignKeys, rows })).digest('hex');
    await source.query('COMMIT');
    return { id: spec.id, tables, foreignKeys, rows, rowCounts, totalRows, redactedCells, sha256 };
  } catch (error) { await source.query('ROLLBACK').catch(() => undefined); throw error; }
}

/** Inserts only into an already-owned, empty target. Never disables triggers or referential constraints. */
export async function restoreSnapshot(target: Client, snapshot: Snapshot) {
  const remaining = new Set(snapshot.tables.map(table => table.name));
  const ordered: string[] = [];
  while (remaining.size) {
    const next = [...remaining].find(table => !snapshot.foreignKeys.some(fk => !fk.deferred && fk.child === table && fk.parent !== table && remaining.has(fk.parent)));
    if (!next) throw new Error('Non-deferrable cross-table FK cycle is unsupported; use a compatible DEFERRABLE test schema');
    remaining.delete(next); ordered.push(next);
  }
  await target.query('BEGIN');
  try {
    await target.query('SET CONSTRAINTS ALL DEFERRED');
    for (const name of ordered) {
      const table = snapshot.tables.find(table => table.name === name)!; const rows = snapshot.rows[name]!;
      if (rows.length) {
        const values: unknown[] = [];
        const placeholders = rows.map(row => '(' + table.columns.map(column => { values.push(row[column]); return `$${values.length}`; }).join(',') + ')');
        await target.query(`INSERT INTO ${qualified(name)} (${table.columns.map(quote).join(',')}) OVERRIDING SYSTEM VALUE VALUES ${placeholders.join(',')}`, values);
      }
      for (const column of table.identities) {
        const sequence = (await target.query<{ sequence: string | null }>('SELECT pg_get_serial_sequence($1,$2) AS sequence', [name, column])).rows[0]!.sequence;
        if (!sequence) continue;
        const properties = (await target.query<{ increment: string; start: string }>('SELECT seqincrement::text AS increment, seqstart::text AS start FROM pg_sequence WHERE seqrelid=$1::regclass', [sequence])).rows[0]!;
        const aggregation = BigInt(properties.increment) > 0 ? 'MAX' : 'MIN';
        const result = (await target.query<{ value: string | null }>(`SELECT ${aggregation}(${quote(column)})::text AS value FROM ${qualified(name)}`)).rows[0]!.value;
        const next = result === null ? properties.start : (BigInt(result) + BigInt(properties.increment)).toString();
        await target.query('SELECT setval($1::regclass,$2::bigint,false)', [sequence, next]);
      }
    }
    await target.query('COMMIT');
  } catch (error) { await target.query('ROLLBACK').catch(() => undefined); throw error; }
}
