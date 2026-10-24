import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['web/app.tsx'], bundle: true, outdir: 'dist', minify: true, sourcemap: false, target: ['es2022'], define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic' });
for (const file of ['index.html', 'favicon.svg']) await copyFile(new URL(`../web/${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
console.log('Built local React workbench.');
