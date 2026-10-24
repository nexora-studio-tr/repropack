import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// GitHub's Windows runner is elevated. PostgreSQL deliberately rejects that identity.
// SAFER NormalUser retains the same account/files but removes administrative rights.
// No account, credential, service or PostgreSQL security setting is changed.
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) throw new Error('This helper only runs on the Windows GitHub Actions runner');
const root = fileURLToPath(new URL('../', import.meta.url)), temporaryRoot = await realpath(process.env.RUNNER_TEMP);
const own = async (directory, owner) => {
  const canonical = await realpath(directory);
  if (dirname(canonical) !== temporaryRoot || !basename(canonical).startsWith('repropack-ci-') || await readFile(join(canonical, '.owner'), 'utf8') !== owner) throw new Error('Windows CI directory ownership mismatch');
  return canonical;
};
if (process.argv[2] === '--child') {
  const directory = await own(resolve(process.argv[3]), process.argv[4]), owner = process.argv[4];
  let code = 1, restricted = false;
  const log = openSync(join(directory, 'checks.log'), 'wx');
  try {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$p = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }'], { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
    if (probe.error || probe.status !== 0) throw new Error('Restricted Windows CI child is still elevated or could not verify its identity');
    restricted = true; await mkdir(join(directory, 'tmp'));
    const result = spawnSync(process.execPath, [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'run', 'check'], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], timeout: 600_000, env: { ...process.env, TEMP: join(directory, 'tmp'), TMP: join(directory, 'tmp') } });
    if (result.error) throw result.error;
    code = result.status ?? 1;
  } catch (error) { console.error(error.message); }
  finally { closeSync(log); await writeFile(join(directory, 'result.json'), JSON.stringify({ owner, code, restricted }), { flag: 'wx' }); }
  process.exitCode = code;
} else {
  const directory = await mkdtemp(join(temporaryRoot, 'repropack-ci-')), owner = randomUUID();
  await writeFile(join(directory, '.owner'), owner, { flag: 'wx' });
  let completed = false;
  try {
    const runas = join(process.env.SystemRoot, 'System32', 'runas.exe');
    const command = '"' + process.execPath + '" "' + fileURLToPath(import.meta.url) + '" --child "' + directory + '" ' + owner;
    const launched = spawnSync(runas, ['/trustlevel:0x20000', command], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (launched.error || launched.status !== 0 || /RUNAS ERROR/iu.test(launched.stdout + launched.stderr)) throw new Error('Could not launch non-administrative Windows CI checks');
    const deadline = Date.now() + 660_000;
    let result;
    while (Date.now() < deadline) {
      try { result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await delay(250); }
    }
    if (!result || result.owner !== owner) throw new Error('Restricted Windows CI checks did not report completion');
    completed = true; process.stdout.write(await readFile(join(directory, 'checks.log'), 'utf8'));
    if (!result.restricted) throw new Error('Administrative execution was not removed; refusing a passing result');
    process.exitCode = result.code;
  } finally {
    if (completed) await rm(await own(directory, owner), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
