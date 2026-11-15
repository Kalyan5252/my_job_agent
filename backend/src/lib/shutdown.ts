/** Registers SIGINT/SIGTERM handlers that run `cleanup` once, then exit. */
export function installShutdown(
  name: string,
  cleanup: () => Promise<void>,
  timeoutMs = 30_000,
): void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${name}] ${signal} received, shutting down`);
    const force = setTimeout(() => {
      console.error(`[${name}] shutdown timed out after ${timeoutMs}ms`);
      process.exit(1);
    }, timeoutMs);
    force.unref();
    cleanup()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`[${name}] shutdown error`, error);
        process.exit(1);
      });
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}
