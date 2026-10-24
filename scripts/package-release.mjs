import { lstat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const directories = ['src', 'web', 'scripts', 'docs', 'test', '.github'];
const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'README.tr.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', '.env.example', '.gitignore', '.dockerignore', 'Dockerfile', 'Dockerfile.sandbox', 'compose.yaml', 'compose.demo.yaml', 'render.yaml', 'examples/cart-discount.json', 'examples/postgres-cart.json', 'examples/cart-session.har.json', 'examples/postgres-app/repropack.json', 'examples/postgres-app/app.ts', 'examples/postgres-app/fixed.ts', 'examples/postgres-app/schema.sql', 'examples/postgres-app/seed.sql', 'examples/sandbox-probe/app.ts'];
const sourceExtension = /\.(?:ts|tsx|mjs|css|svg|html|md|json|ya?ml)$/u;
export async function releaseFiles(root) {
  const selected = [...files];
  async function walk(path) {
    if (/(?:^|\/)(?:node_modules|\.git|\.repropack|artifacts|dist)(?:\/|$)/u.test(path)) return;
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`Release refuses a symlink: ${path}`);
    if (info.isDirectory()) { for (const name of (await readdir(join(root, path))).sort()) await walk(`${path}/${name}`); }
    else if (info.isFile() && sourceExtension.test(path) && !/(?:^|\/)(?:\.env(?:\.|$)|node_modules|\.git|\.repropack|artifacts|dist)(?:\/|$)/u.test(path) && !/\.(?:sqlite|pem|key|log)(?:\.|$)/u.test(path)) selected.push(path);
  }
  for (const directory of directories) await walk(directory);
  for (const path of selected) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink() || path.includes('..') || path.includes('\\') || resolve(root, path) === root || relative(root, resolve(root, path)).startsWith(`..${sep}`)) throw new Error(`Unsafe release entry: ${path}`);
  }
  return selected.sort();
}
export function tarEntry(path, content) {
  if (!/^[a-zA-Z0-9_./-]+$/u.test(path) || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unsafe archive path');
  const header = Buffer.alloc(512); let name = path, prefix = '';
  if (Buffer.byteLength(path) > 100) { const split = path.lastIndexOf('/'); name = path.slice(split + 1); prefix = path.slice(0, split); }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('Archive path exceeds USTAR limits');
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
  header.write(name, 0, 100); header.write(octal(0o644, 8), 100, 8); header.write(octal(0, 8), 108, 8); header.write(octal(0, 8), 116, 8);
  header.write(octal(content.length, 12), 124, 12); header.write(octal(0, 12), 136, 12); header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263); header.write(prefix, 345, 155);
  const sum = header.reduce((total, value) => total + value, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}
export async function packageRelease(root, output = join(root, 'artifacts', 'release')) {
  const meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (meta.name !== 'repropack' || !/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(meta.version)) throw new Error('Unexpected release identity');
  const prefix = `repropack-${meta.version}`, entries = [], manifest = [];
  for (const path of await releaseFiles(root)) {
    const content = await readFile(join(root, path));
    manifest.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    entries.push(tarEntry(`${prefix}/${path}`, content));
  }
  entries.push(tarEntry(`${prefix}/RELEASE-MANIFEST.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, version: meta.version, files: manifest }, null, 2) + '\n')));
  const archive = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), { level: 9 });
  const sha256 = createHash('sha256').update(archive).digest('hex');
  await mkdir(output, { recursive: true }); const destination = join(output, `${prefix}.tgz`);
  await writeFile(destination, archive, { flag: 'wx' });
  await writeFile(`${destination}.sha256`, `${sha256}  ${prefix}.tgz\n`, { flag: 'wx' });
  return { archive: destination, sha256, fileCount: manifest.length, bytes: archive.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Use npm run release:package -- [NEW-output-directory]');
    console.log(JSON.stringify(await packageRelease(fileURLToPath(new URL('../', import.meta.url)), process.argv[2] ? resolve(process.argv[2]) : undefined)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
