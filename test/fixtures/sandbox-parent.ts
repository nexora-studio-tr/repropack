import { createSandbox } from '../../src/sandbox/host.ts';
import { parseExecution } from '../../src/sandbox/policy.ts';
import type { TrialInput } from '../../src/sandbox/host.ts';
process.once('message', async raw => {
  const input = raw as { execution: unknown; directory: string; trial: TrialInput };
  try {
    const sandbox = await createSandbox(parseExecution(input.execution), input.directory);
    await sandbox.execute(input.trial, new AbortController().signal);
  } finally { if (process.connected) process.disconnect(); }
});
