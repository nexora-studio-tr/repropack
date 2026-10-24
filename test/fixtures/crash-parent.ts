import { createCluster } from '../../src/postgres/cluster.ts';
import { launchApplication } from '../../src/postgres/application.ts';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const cluster = await createCluster(join(process.argv[2]!, 'postgres'));
if (process.argv[3] === 'starting') process.send?.({ type: 'ready', directory: cluster.directory });
else {
  const application = await launchApplication(fileURLToPath(new URL('./hang.ts', import.meta.url)), cluster.adminUrl, new AbortController().signal);
  process.send?.({ type: 'ready', directory: cluster.directory, postgresPort: Number(new URL(cluster.adminUrl).port), origin: application.origin });
}
setInterval(() => undefined, 1000);
