/**
 * `tq daemon` command.
 *
 * Starts the HTTP server, writes the descriptor, and waits for shutdown.
 */

export async function commandDaemon(
  dataDir: string,
  port: number,
  flags: Record<string, string | true>,
): Promise<number> {
  const fs = require("node:fs");

  // Ensure data directory exists
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  } catch (err: any) {
    console.error(`Error creating data directory ${dataDir}: ${err.message}`);
    return 1;
  }

  // Try to bind to the port
  let actualPort = port;
  let server: ReturnType<typeof Bun.serve>;

  try {
    server = Bun.serve({
      port,
      fetch(req) {
        return new Response("tq daemon running", { status: 200 });
      },
    });
    actualPort = server.port;
  } catch (err: any) {
    console.error(`Error: cannot bind to port ${port}: ${err.message}`);
    return 1;
  }

  // Write descriptor
  const descriptor = {
    pid: process.pid,
    port: actualPort,
    dataDir,
    startedAt: new Date().toISOString(),
  };

  fs.writeFileSync(`${dataDir}/daemon.json`, JSON.stringify(descriptor, null, 2));

  console.log(`tq daemon running on http://localhost:${actualPort}`);
  console.log(`Data directory: ${dataDir}`);
  console.log("Press Ctrl+C to stop");

  // Handle shutdown
  const descriptorPath = `${dataDir}/daemon.json`;
  const controller = new AbortController();
  const shutdown = () => {
    console.error("\nShutting down...");
    try { fs.unlinkSync(descriptorPath); } catch {}
    server.stop();
    controller.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Wait until aborted
  await new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => {
      resolve();
    });
  });
  process.exit(0);
}
