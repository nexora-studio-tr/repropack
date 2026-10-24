process.env.REPROPACK_DEMO = '1';
process.env.REPROPACK_PORT ??= '4320';
const { spawn } = await import('node:child_process');
const child = spawn(process.execPath, ['src/server.ts'], { env: process.env, windowsHide: true, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', () => { console.error('The demo server could not start.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
