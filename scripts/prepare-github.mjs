import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkRelease } from './release-check.mjs';
import { releaseFiles, sourceBytes } from './package-release.mjs';

/** Prepare a new source-only staging directory. Does not initialize the parent repository. */
export async function prepareGithub(root) {
  const report = await checkRelease(root), parent = join(root, 'artifacts', 'github');
  await mkdir(parent, { recursive: true });
  const directory = join(parent, 'repropack-' + report.version); await mkdir(directory, { recursive: false });
  const source = join(directory, 'source'); await mkdir(source);
  const files = [];
  for (const path of await releaseFiles(root)) {
    const content = await sourceBytes(root, path);
    const segments = path.split('/'); segments.pop(); if (segments.length) await mkdir(join(source, ...segments), { recursive: true });
    await writeFile(join(source, path), content, { flag: 'wx' });
    files.push({ path, sha256: createHash('sha256').update(content).digest('hex') });
  }
  const sourceSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  if (sourceSha256 !== report.sourceSha256) throw new Error('Source changed during staging; do not publish this staging directory');
  const manifest = { schemaVersion: 1, repository: 'nexora-studio-tr/repropack', visibility: 'public', version: report.version, sourceSha256, files };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { directory, source, version: report.version, fileCount: files.length, sourceSha256 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareGithub(fileURLToPath(new URL('../', import.meta.url))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
