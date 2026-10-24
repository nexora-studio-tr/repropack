import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { releaseFiles } from './package-release.mjs';
const secretRules = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/u],
  ['payment credential', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/u],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ['workstation path', /C:[\\/]Users[\\/]enes_[\\/]/iu],
];
/** Check only the source allowlist, without reading runtime state or sibling projects. */
export async function checkRelease(root) {
  const meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')), lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (meta.version !== lock.version || meta.version !== lock.packages[''].version) throw new Error('Package/lockfile versions differ');
  const paths = await releaseFiles(root), manifest = [], failures = [];
  for (const path of paths) {
    if (/(?:^|\/)(?:node_modules|artifacts|dist|\.git|\.repropack|discord-security-bot|hunt-core-pro)(?:\/|$)/u.test(path) || (/(?:^|\/)\.env/u.test(path) && path !== '.env.example')) failures.push(path + ': private/runtime path');
    const bytes = await readFile(join(root, path)), content = bytes.toString('utf8');
    for (const [label, pattern] of secretRules) if (pattern.test(content)) failures.push(path + ': ' + label);
    if (path.startsWith('.github/workflows/')) for (const match of content.matchAll(/^\s*-?\s*uses:\s*(\S+)/gmu)) if (!match[1].startsWith('./') && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/u.test(match[1])) failures.push(path + ': action must be pinned to a full commit SHA');
    manifest.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  for (const path of ['LICENSE', 'SECURITY.md', 'README.md', 'README.tr.md', 'docs/ACCOUNT-SECURITY.md', 'docs/PILOT.md', 'render.yaml', '.github/workflows/ci.yml', '.github/workflows/release.yml']) if (!paths.includes(path)) failures.push(path + ': required release file missing');
  if (failures.length) throw new Error('Release checks failed:\n' + failures.join('\n'));
  return { status: 'passed', version: meta.version, files: manifest.length, sourceSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), scope: 'ReproPack source allowlist only', limitations: ['Pattern checks do not replace an independent security audit', 'Live email, hosting and remote CI need separate verification'] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url)), report = await checkRelease(root), output = join(root, 'artifacts', 'release-readiness');
    await mkdir(output, { recursive: true }); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
