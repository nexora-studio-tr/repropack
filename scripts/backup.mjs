import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat, writeFile, rm } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function validateDatabase(database) {
  if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
  for (const name of ['runs', 'users', 'teams', 'memberships', 'sessions', 'invitations', 'settings']) if (!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)) throw new Error('This is not an initialized ReproPack database');
  if (!database.prepare("SELECT value FROM settings WHERE key = 'instance_owner'").get() || database.prepare("SELECT value FROM settings WHERE key = 'instance_mode'").get()?.value === 'demo') throw new Error('Only an initialized private workbench can be backed up/restored');
}
export async function createBackup(directory, output = join(directory, 'backups')) {
  const source = resolve(directory, 'runs.sqlite');
  const database = new DatabaseSync(source, { readOnly: true });
  let destination, owned = false;
  try {
    validateDatabase(database); await mkdir(output, { recursive: true, mode: 0o700 });
    destination = resolve(output, `repropack-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`);
    await (await open(destination, 'wx', 0o600)).close();
    owned = true;
    await backup(database, destination);
    const copy = new DatabaseSync(destination, { readOnly: true }); try { validateDatabase(copy); } finally { copy.close(); }
    const manifest = { schemaVersion: 1, kind: 'repropack-private-backup', createdAt: new Date().toISOString(), file: basename(destination), sha256: await fileHash(destination), bytes: (await stat(destination)).size, includes: ['accounts', 'teams', 'run history', 'audit'], excludes: ['application/source configuration', 'PostgreSQL snapshot data'], restoreInvalidatesSessionsAndInvites: true };
    await writeFile(`${destination}.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { backup: destination, manifest: `${destination}.json`, sha256: manifest.sha256 };
  } catch (error) { if (owned) await rm(destination, { force: true }); throw error; }
  finally { database.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await createBackup(resolve(process.env.REPROPACK_DATA_DIR || '.repropack'), process.argv[2] ? resolve(process.argv[2]) : undefined))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
