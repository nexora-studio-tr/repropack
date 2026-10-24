const port = Number(process.env.PORT ?? process.env.REPROPACK_PORT ?? 4317);
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok || (await response.json()).status !== 'ok') process.exitCode = 1;
} catch { process.exitCode = 1; }
