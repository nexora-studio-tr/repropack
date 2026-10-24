import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const child = spawn('docker', ['build', '--file', 'Dockerfile', '--tag', `repropack:${version}`, '.'], { cwd: root, windowsHide: true, stdio: 'inherit' });
child.once('error', () => { console.error('A running Linux Docker engine is required.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
