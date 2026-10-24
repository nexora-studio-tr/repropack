import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { parseCapsule } from '../core/model.ts';
import { importHar, approveCapture } from './har.ts';

export async function captureCommand(command: string, args: string[]) {
  const file = args.shift(); if (!file) throw new Error('Provide the HAR/draft JSON file');
  const options = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!; const value = args.shift();
    if (!value || !['--origin', '--base', '--out', '--redact', '--sha256'].includes(key) || options.has(key)) throw new Error('Invalid capture option');
    options.set(key, value);
  }
  if ((await stat(file)).size > 4_194_304) throw new Error('Capture input exceeds 4 MiB');
  const input: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (command === 'import-har') {
    const base = options.get('--base'); const origin = options.get('--origin');
    if (!base || !origin || options.has('--sha256')) throw new Error('Use import-har trace.har --origin https://your-origin --base capsule.json [--redact /customer/email] [--out artifacts/draft]');
    const draft = importHar(input, origin, parseCapsule(JSON.parse(await readFile(base, 'utf8'))), options.get('--redact')?.split(',') ?? []);
    const directory = resolve(options.get('--out') ?? join('artifacts', `capture-${Date.now()}`)); await mkdir(directory, { recursive: true });
    const target = join(directory, 'capture-draft.json');
    await writeFile(target, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx' });
    console.log(`Draft only: ${target}\nImported ${draft.summary.imported} requests; masked ${draft.summary.redactedValues} values; discarded ${draft.summary.headersDiscarded} headers.\nReview paths and all payloads for remaining private data. The last request is the oracle. No requests were executed.\nReviewed hash: ${draft.sha256}\nAfter inspection: node src/cli.ts approve-capture "${target}" --sha256 ${draft.sha256}`);
  } else {
    if (!options.get('--sha256') || [...options.keys()].some(key => key !== '--sha256')) throw new Error('Use approve-capture capture-draft.json --sha256 <reviewed hash>');
    const approved = approveCapture(input, options.get('--sha256')!);
    const directory = dirname(resolve(file));
    await writeFile(join(directory, 'capsule.reviewed.json'), JSON.stringify(approved.capsule, null, 2) + '\n', { flag: 'wx' });
    await writeFile(join(directory, 'review-receipt.json'), JSON.stringify(approved.receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(`Reviewed capsule: ${join(directory, 'capsule.reviewed.json')}\nNo replay or upload was performed.`);
  }
}
