import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { mkdir, readFile, copyFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fileHash, validateDatabase } from './backup.mjs';

export async function restoreBackup(source, directory) {
  const path = await realpath(source);
  const manifest = JSON.parse(await readFile(`${source}.json`, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'repropack-private-backup' || manifest.file !== basename(source) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || await fileHash(path) !== manifest.sha256) throw new Error('Backup manifest/checksum does not match');
  const original = new DatabaseSync(path, { readOnly: true }); try { validateDatabase(original); } finally { original.close(); }
  // No recursive overwrite or replacement of an existing workspace is supported.
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const databasePath = join(directory, 'runs.sqlite'); await copyFile(path, databasePath, constants.COPYFILE_EXCL);
  if (await fileHash(databasePath) !== manifest.sha256) throw new Error('Backup changed while being restored; the original workspace was preserved');
  const database = new DatabaseSync(databasePath);
  try {
    validateDatabase(database); database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    try {
      database.exec('DELETE FROM sessions'); database.prepare('UPDATE invitations SET used_at = ? WHERE used_at IS NULL').run(Date.now());
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_tokens'").get()) database.exec('DELETE FROM account_tokens');
      const actor = database.prepare("SELECT value FROM settings WHERE key = 'instance_owner'").get().value;
      for (const team of database.prepare('SELECT id FROM teams').all()) database.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?,?)').run(randomUUID(), team.id, actor, 'instance.restored', '', JSON.stringify({ sha256: manifest.sha256 }), Date.now());
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } finally { database.close(); }
  await writeFile(join(directory, 'RESTORE.json'), JSON.stringify({ restoredAt: new Date().toISOString(), sourceSha256: manifest.sha256, sessionsRevoked: true, invitationsRevoked: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { dataDirectory: resolve(directory), sessionsRevoked: true, invitationsRevoked: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Use: node scripts/restore.mjs backup.sqlite NEW-data-directory');
    console.log(JSON.stringify(await restoreBackup(resolve(process.argv[2]), resolve(process.argv[3]))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
