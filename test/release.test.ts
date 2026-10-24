import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('publication preflight rejects exposed keys and unpinned actions without reading runtime or sibling code', async () => {
  const { checkRelease } = await import(new URL('../scripts/release-check.mjs', import.meta.url).href);
  const { releaseFiles } = await import(new URL('../scripts/package-release.mjs', import.meta.url).href);
  const directory = await mkdtemp(join(tmpdir(), 'repropack-release-check-'));
  try {
    const paths = await releaseFiles(root) as string[];
    for (const path of paths) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), await readFile(join(root, path))); }
    for (const name of ['.repropack', 'artifacts', 'discord-security-bot']) { await mkdir(join(directory, name), { recursive: true }); await writeFile(join(directory, name, 'private.txt'), 'not published'); }
    const good = await checkRelease(directory); assert.equal(good.status, 'passed'); assert.equal(good.files, paths.length);
    const readme = await readFile(join(directory, 'README.md'), 'utf8');
    await writeFile(join(directory, 'README.md'), readme + '\n' + 'gh' + 'p_' + 'a'.repeat(36));
    await assert.rejects(checkRelease(directory), /README.md: GitHub token/u);
    await writeFile(join(directory, 'README.md'), readme);
    const ci = join(directory, '.github', 'workflows', 'ci.yml');
    await writeFile(ci, (await readFile(ci, 'utf8')).replace(/actions\/checkout@[a-f0-9]{40}/u, 'actions/checkout@main'));
    await assert.rejects(checkRelease(directory), /action must be pinned/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
