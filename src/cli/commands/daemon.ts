/**
 * `tq daemon` command.
 *
 * Starts the HTTP server, writes the descriptor, and waits for shutdown.
 */
import { resolveDataDir, openDatabase, closeDatabase, bootstrapDataDir, configureDatabase } from "../../db/database.ts";

export async function commandDaemon(
  dataDir: string,
  port: number,
  flags: Record<string, string | true>,
): Promise<number> {
  const fs = require("node:fs");

  // Bootstrap data directory (creates dir, log dir)
  const dbConfig = resolveDataDir(dataDir);
  try {
    bootstrapDataDir(dbConfig);
  } catch (err: any) {
    console.error(`Error creating data directory ${dataDir}: ${err.message}`);
    return 1;
  }

  // Open database
  let db;
  try {
    db = openDatabase(dbConfig.dbPath);
    configureDatabase(db);
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
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
    if (db) closeDatabase(db);
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
