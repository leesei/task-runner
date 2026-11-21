/**
 * `tq daemon` command.
 *
 * Starts the HTTP server, writes the descriptor, and waits for shutdown.
 * Serves the REST API and dashboard via Bun.serve.
 */
import {
  resolveDataDir,
  openDatabase,
  closeDatabase,
  bootstrapDataDir,
  configureDatabase,
} from "../../db/database.ts";
import { createLifecycle } from "../../core/lifecycle.ts";
import { createEventBus } from "../../core/events.ts";
import { createCore } from "../../core/service.ts";
import { createRunner } from "../../runner/runner.ts";
import { installConsoleInterception } from "../../runner/execution.ts";
import { createApi } from "../../api/index.ts";
import { getDashboardHtml } from "../dashboard.ts";

export async function commandDaemon(
  dataDir: string,
  port: number,
  flags: Record<string, string | true>,
  projectRoot: string = process.cwd(),
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

  const events = createEventBus();
  const lifecycle = createLifecycle({
    db,
    events,
    logDir: dbConfig.logDir,
    defaultCwd: projectRoot,
  });
  const core = createCore({
    db,
    lifecycle,
    projectRoot,
    dataDir,
  });

  // Discover and load tasks from the project root, not the process cwd:
  // the CLI may have been started from a different directory.
  const cwd = projectRoot;
  const { loaded, warnings } = core.reload();
  console.log(`Loaded ${loaded} task(s)`);
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }

  // Reset abandoned attempts, keep STOPPED queues stopped, autostart the rest.
  const { reset, started, stayedStopped } = core.recoverOnBoot();
  if (reset > 0) {
    console.log(`Crash recovery: reset ${reset} RUNNING instance(s) to PENDING`);
  }
  console.log(`Autostart: ${started} queue(s) processing, ${stayedStopped} stayed stopped`);

  // Install console interception for log capture
  installConsoleInterception();

  // Create the API router (after tasks are loaded so reload works correctly)
  const apiRouter = createApi({ core, events, dataDir, cwd });

  // Start the runner loop
  const runner = createRunner({
    db,
    lifecycle,
    onReload: () => {
      const result = core.reload();
      console.log(`Reloaded ${result.loaded} task(s)`);
      for (const warning of result.warnings) {
        console.warn(`Warning: ${warning}`);
      }
    },
  });
  console.log("Runner loop started");

  // Deleting an instance removes its row; abort any execution still running
  // for it so the process does not outlive the record.
  events.subscribe((event) => {
    if (event.type === "instancesCleared") {
      runner.cancelInstances(event.instanceIds);
    }
  });

  runner.runContinuous().catch((err) => {
    console.error("Runner loop error:", err);
  });

  // Try to bind to the port
  let actualPort = port;
  let server: ReturnType<typeof Bun.serve>;

  try {
    server = Bun.serve({
      port,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
          return apiRouter(req, server);
        }
        // Serve dashboard for root and other non-API routes
        return new Response(getDashboardHtml(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
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
    try {
      fs.unlinkSync(descriptorPath);
    } catch {}
    if (db) closeDatabase(db);
    server.stop();
    controller.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => {
      resolve();
    });
  });
  process.exit(0);
}
