/**
 * `tq` CLI entry point.
 *
 * Routes subcommands to their handlers. Every command calls the shared core
 * in-process; the CLI never calls the daemon HTTP API. Daemon liveness is
 * checked from the descriptor pid.
 */

import {
  getStringFlag,
  parseArgs,
  printDaemonUsage,
  printUsage,
} from "./args.ts";
import { commandAbort } from "./commands/abort.ts";
import { commandAdd } from "./commands/add.ts";
import { commandClear } from "./commands/clear.ts";
import { commandConfig } from "./commands/config.ts";
import { commandDaemon } from "./commands/daemon.ts";
import { commandInstall } from "./commands/install.ts";
import { commandLogs } from "./commands/logs.ts";
import { commandReload } from "./commands/reload.ts";
import { commandStart } from "./commands/start.ts";
import { commandStatus } from "./commands/status.ts";
import { commandStop } from "./commands/stop.ts";
import { resolveCliDataDir } from "./data-dir.ts";

function findDaemonDescriptor(
  dataDir: string,
): { port: number; pid: number } | null {
  try {
    const path = `${dataDir}/daemon.json`;
    // Synchronously read for CLI use
    const raw = require("node:fs").readFileSync(path, "utf-8");
    if (!raw) return null;
    return JSON.parse(raw) as { port: number; pid: number };
  } catch {
    return null;
  }
}

/**
 * The CLI only needs to know whether a daemon owns this data directory. It
 * checks the descriptor pid instead of probing the daemon's HTTP API.
 */
function findLiveDaemon(dataDir: string): { port: number; pid: number } | null {
  const descriptor = findDaemonDescriptor(dataDir);
  if (!descriptor) return null;

  try {
    process.kill(descriptor.pid, 0);
    return descriptor;
  } catch {
    return null;
  }
}

export async function main(args: string[]): Promise<number> {
  const parsed = parseArgs(args);

  const { dataDir, projectRoot } = resolveCliDataDir(parsed.flags, args[1]);

  const cmd = parsed.positional[0];

  // --help for specific subcommands
  if (cmd === "daemon" && parsed.flags["help"] !== undefined) {
    printDaemonUsage();
    return 0;
  }
  if (parsed.flags["help"] !== undefined) {
    printUsage();
    return 0;
  }

  // Running `tq` bare shows help; the daemon requires the explicit subcommand.
  if (!cmd) {
    printUsage();
    return 0;
  }

  if (cmd === "daemon") {
    const port = parseInt(
      getStringFlag(parsed.flags, "port", "TQ_PORT", "3000"),
      10,
    );
    return await commandDaemon(dataDir, port, parsed.flags, projectRoot);
  }

  // Discover a live daemon from the descriptor pid. No HTTP probe is made.
  const descriptor = findLiveDaemon(dataDir);
  const daemonRunning = descriptor !== null;
  const daemonPort = descriptor?.port ?? null;

  switch (cmd) {
    case "add":
      return await commandAdd(
        dataDir,
        parsed.positional.slice(1),
        parsed.flags,
      );
    case "start":
      return await commandStart(
        dataDir,
        daemonRunning,
        parsed.positional[1],
        parsed.flags,
      );
    case "stop":
      return await commandStop(
        dataDir,
        daemonRunning,
        parsed.positional[1],
        parsed.flags,
      );
    case "abort":
      return await commandAbort(
        dataDir,
        daemonRunning,
        parsed.positional[1],
        parsed.flags,
      );
    case "clear":
      return await commandClear(
        dataDir,
        parsed.positional.slice(1),
        parsed.flags,
      );
    case "status":
      return await commandStatus(dataDir, parsed.flags);
    case "config":
      return await commandConfig(dataDir, daemonPort, parsed.flags, projectRoot);
    case "logs":
      return await commandLogs(
        dataDir,
        parsed.positional.slice(1),
        parsed.flags,
      );
    case "install":
      return await commandInstall(
        dataDir,
        daemonRunning,
        projectRoot,
        parsed.positional.slice(1),
        parsed.flags,
      );
    case "reload":
      return await commandReload(
        dataDir,
        daemonRunning,
        projectRoot,
        parsed.flags,
      );
    default:
      console.error(`Unknown command: ${cmd}`);
      printUsage();
      return 2;
  }
}

// If run directly (not imported)
if (import.meta.main) {
  const exitCode = await main(process.argv);
  process.exit(exitCode);
}
