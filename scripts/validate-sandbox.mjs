import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, delimiter } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { docker, preflight, requireLinuxEngine } from '../src/sandbox/docker.ts';
import { parseExecution } from '../src/sandbox/policy.ts';

// Explicit validation command: builds/tests only. Never installs Docker or changes Windows/WSL.
const root = fileURLToPath(new URL('../', import.meta.url));
const id = randomUUID();
const output = join(root, 'artifacts', 'sandbox-validation', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${id.slice(0, 8)}`);
await mkdir(output, { recursive: true });
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const report = { schemaVersion: 1, id, version, startedAt: new Date().toISOString(), status: 'blocked', stage: 'engine', host: { platform: process.platform, arch: process.arch, node: process.version }, realSmokeExecuted: false, checksPassed: [] };

// A per-user Windows installation need not have updated this already-running terminal's PATH.
if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
  const candidates = [join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin'), ...(process.env.ProgramFiles ? [join(process.env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin')] : [])];
  const directory = candidates.find(candidate => existsSync(join(candidate, 'docker.exe')));
  if (directory) process.env.PATH = `${directory}${delimiter}${process.env.PATH ?? ''}`;
}
async function run(command, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Validation child exited with ${signal ?? code}`)));
  });
}
try {
  if (process.argv.length > 2) throw new Error('No CLI arguments accepted. Set REPROPACK_SANDBOX_IMAGE to validate an existing immutable local image.');
  console.log('Checking the real Linux Docker engine…');
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
  const engineId = requireLinuxEngine(info);
  report.engine = { id: engineId, os: info.OSType, cgroupVersion: info.CgroupVersion, serverVersion: info.ServerVersion };
  report.stage = 'image';
  let image = process.env.REPROPACK_SANDBOX_IMAGE;
  if (!image) {
    const tag = `repropack-sandbox:validation-${id.slice(0, 8)}`;
    report.builtTag = tag;
    console.log(`Building the project runtime: ${tag}`);
    await run('docker', ['build', '--file', 'Dockerfile.sandbox', '--tag', tag, '--label', `io.repropack.validation=${id}`, '.']);
    image = JSON.parse(await docker(['image', 'inspect', tag]))[0]?.Id;
  }
  const execution = parseExecution({ kind: 'docker', image, module: '/opt/repropack/examples/postgres-app/app.ts', fixedModule: '/opt/repropack/examples/postgres-app/fixed.ts' });
  const prepared = await preflight(execution);
  if (prepared.engineId !== engineId) throw new Error('Docker engine changed during validation; restore the original context.');
  report.image = prepared.image;
  report.quotas = prepared.quotas;
  report.stage = 'real-smoke';
  report.realSmokeExecuted = true;
  console.log('Running real failure/fix, isolation, cgroup and crash tests…');
  await run(process.execPath, ['scripts/sandbox-smoke.mjs'], { ...process.env, REPROPACK_SANDBOX_IMAGE: image });
  report.checksPassed = ['failure-and-fix', 'host-secret-exclusion', 'read-only-root', 'external-network-denied', 'cgroup-memory-cpu-pid', 'kernel-oom', 'pid-quota', 'wall-deadline', 'parent-crash-cleanup'];
  report.status = 'passed';
  report.stage = 'complete';
} catch (error) {
  report.status = report.stage === 'engine' ? 'blocked' : 'failed';
  report.reason = error instanceof Error ? error.message : 'Sandbox validation failed';
  console.error(report.reason);
  process.exitCode = report.status === 'blocked' ? 2 : 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const file = join(output, 'report.json');
  await writeFile(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Sandbox validation: ${report.status}\nReport: ${file}`);
}
