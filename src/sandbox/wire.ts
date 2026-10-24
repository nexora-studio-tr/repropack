import type { Snapshot } from '../postgres/snapshot.ts';

/** Restore only SQL bytea columns; an identical object inside JSON/JSONB is user data. */
export function reviveSnapshot(snapshot: Snapshot): Snapshot {
  for (const table of snapshot.tables) {
    for (let index = 0; index < table.columns.length; index++) {
      if (table.types[index] !== 'bytea') continue;
      const column = table.columns[index]!;
      for (const row of snapshot.rows[table.name]!) {
        const value = row[column]; if (value === null || Buffer.isBuffer(value)) continue;
        const encoded = value as { type?: unknown; data?: unknown } | undefined;
        if (!encoded || encoded.type !== 'Buffer' || !Array.isArray(encoded.data) || !encoded.data.every((byte: unknown) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('Invalid bytea snapshot transport');
        row[column] = Buffer.from(encoded.data as number[]);
      }
    }
  }
  return snapshot;
}
