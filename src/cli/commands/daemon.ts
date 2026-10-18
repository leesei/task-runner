/**
 * `tq daemon` command.
 *
 * Starts the HTTP server, writes the descriptor, and waits for shutdown.
 * Serves the REST API and dashboard via Bun.serve.
 */
import { resolveDataDir, openDatabase, closeDatabase, bootstrapDataDir, configureDatabase } from "../../db/database.ts";
import { loadAllTasks } from "../../tasks/discovery.ts";
import { getPackageLocations } from "../../tasks/lockfile.ts";
import { autostartQueuesOnBoot, ensureQueuesForTasks } from "../../runner/queue-state.ts";
import { createRunner } from "../../runner/runner.ts";
import { installConsoleInterception } from "../../runner/execution.ts";
import { createApi } from "../../api/index.ts";

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

  // Discover and load tasks
  const cwd = process.cwd();
  const packageLocations = getPackageLocations(dataDir);
  const { loaded, warnings } = loadAllTasks(db, cwd, packageLocations);
  console.log(`Loaded ${loaded} task(s)`);
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }

  // Ensure queues exist for all tasks
  ensureQueuesForTasks(db);

  // Autostart queues (STOPPED stay STOPPED, others enter PROCESSING)
  const { started, stayedStopped } = autostartQueuesOnBoot(db);
  console.log(`Autostart: ${started} queue(s) processing, ${stayedStopped} stayed stopped`);

  // Install console interception for log capture
  installConsoleInterception();

  // Create the API router (after tasks are loaded so reload works correctly)
  const apiRouter = createApi({ db, dataDir, cwd });

  // Start the runner loop
  const runner = createRunner({ dataDir });
  console.log("Runner loop started");

  // Run runner in background
  runner.runContinuous(db).catch(err => {
    console.error("Runner loop error:", err);
  });

  // Try to bind to the port
  let actualPort = port;
  let server: ReturnType<typeof Bun.serve>;

  try {
    server = Bun.serve({
      port,
      fetch(req) {
        // Serve API under /api/*, dashboard at / and /*
        const url = new URL(req.url);
        if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
          return apiRouter(req);
        }
        // Dashboard placeholder
        return new Response(" tq dashboard (not yet implemented) ", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    actualPort = server.port ?? port;
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
