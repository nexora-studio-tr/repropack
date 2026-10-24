import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCapsule } from './core/model.ts';
import { minimize } from './core/minimize.ts';
import { createAdapterRegistry } from './adapters/sessions.ts';
import { captureCommand } from './capture/cli.ts';
import { parseExecution } from './sandbox/policy.ts';
import { preflight } from './sandbox/docker.ts';

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === 'sandbox-doctor') {
    const image = args.length === 2 && args[0] === '--image' ? args[1] : args.length === 0 ? process.env.REPROPACK_SANDBOX_IMAGE : undefined;
    if (!image) throw new Error('Use sandbox-doctor --image sha256:<local-image-id>, or set REPROPACK_SANDBOX_IMAGE.');
    const policy = parseExecution({ kind: 'docker', image, module: '/opt/repropack/examples/postgres-app/app.ts' });
    console.log(JSON.stringify(await preflight(policy), null, 2)); return;
  }
  if (command === 'import-har' || command === 'approve-capture') { await captureCommand(command, args); return; }
  if (command === '--help' || !command) {
    console.log('ReproPack local alpha\n\n  npm run demo\n  npm run demo:postgres\n  node src/cli.ts reduce capsule.json [--config ./trusted/repropack.json] [--out artifacts/name] [--max-trials 160]\n  node src/cli.ts sandbox-doctor --image sha256:<local-image-id>\n  node src/cli.ts import-har trace.har --origin https://your-origin --base capsule.json [--out artifacts/draft] [--redact /customer/email]\n  node src/cli.ts approve-capture capture-draft.json --sha256 <reviewed-hash>\n\nDefault: trusted native execution. Optional Docker mode enforces isolation/quotas and never falls back. No system service or production capture is started.'); return;
  }
  if (!['demo', 'postgres-demo', 'reduce'].includes(command)) throw new Error('Unknown command. Use --help.');
  const file = command === 'demo' ? fileURLToPath(new URL('../examples/cart-discount.json', import.meta.url)) : command === 'postgres-demo' ? fileURLToPath(new URL('../examples/postgres-cart.json', import.meta.url)) : args.shift();
  if (!file) throw new Error('Provide a capsule JSON path.');
  let output = resolve('artifacts', `repro-${Date.now()}`), maxTrials = 160;
  let applicationConfig: string | undefined;
  while (args.length) {
    const option = args.shift();
    const value = args.shift();
    if (!value || !['--out', '--max-trials', '--config'].includes(option ?? '')) throw new Error('Unsupported or incomplete option');
    if (option === '--out') output = resolve(value);
    else if (option === '--config') applicationConfig = resolve(value);
    else maxTrials = Number(value);
  }
  const capsule = parseCapsule(JSON.parse(await readFile(file, 'utf8')));
  const registry = await createAdapterRegistry(resolve('.repropack'), applicationConfig);
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException('Cancelled', 'AbortError'));
  process.once('SIGINT', cancel);
  try {
    const session = await registry.acquire(capsule);
    const report = await minimize(capsule.steps, session.execute(), { anchorId: capsule.oracle.stepId, maxTrials, timeoutMs: session.timeoutMs, signal: controller.signal });
    const reduced = { ...capsule, steps: capsule.steps.filter(step => report.reducedStepIds.includes(step.id)) };
    let fixVerified = false;
    if (report.status === 'completed' && report.finalVerified && session.hasFix) {
      fixVerified = true;
      for (let i = 0; i < 3; i++) if ((await session.execute(true)(reduced.steps, AbortSignal.timeout(20_000))).verdict !== 'pass') fixVerified = false;
    }
    await mkdir(output, { recursive: true });
    // Never overwrite an existing bundle, including evidence from a previous run.
    await writeFile(join(output, 'report.json'), JSON.stringify({ ...report, environment: session.evidence, fixVerification: { available: session.hasFix, passed: fixVerified, attempts: session.hasFix && report.finalVerified ? 3 : 0 } }, null, 2) + '\n', { flag: 'wx' });
    if (report.status === 'completed' && report.finalVerified) await writeFile(join(output, 'capsule.json'), JSON.stringify(reduced, null, 2) + '\n', { flag: 'wx' });
    await writeFile(join(output, 'REPRODUCE.md'), `# Reproduction bundle\n\nRequires ReproPack and Node.js 24.15+. Adapter: ${capsule.adapter}.\n\nStatus: ${report.status}. Failure preserved: ${report.finalVerified}. Registered fix verified: ${fixVerified}.\n\n${report.reason}\n\nFor completed output, replay from the project root:\n\n\`\`\`sh\nnode src/cli.ts reduce capsule.json${applicationConfig ? ' --config /path/to/your/trusted/repropack.json' : ''}\n\`\`\`\n\nPostgreSQL capsules need the registered application and its snapshot configuration. Only hashes/counts are exported here; source rows and credentials are not included. Incomplete reductions contain no capsule.json.\n`, { flag: 'wx' });
    console.log(`${capsule.title}\n${report.originalSteps} → ${report.reducedSteps} steps · ${report.trials} trials · ${report.status}\nFailure preserved: ${report.finalVerified} · Registered fix verified: ${fixVerified}\n${report.reason}\nBundle: ${output}`);
    if (report.status !== 'completed' || !report.finalVerified || (session.hasFix && !fixVerified)) process.exitCode = 2;
  } finally { process.removeListener('SIGINT', cancel); await registry.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
