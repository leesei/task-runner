/**
 * `tq` CLI entry point.
 *
 * Routes subcommands to their handlers. When the daemon is reachable, mutations
 * go through the HTTP API. When not, offline-capable commands operate directly
 * on SQLite.
 */

import { parseArgs, printUsage, printDaemonUsage, getStringFlag } from "./args.ts";
import { commandDaemon } from "./commands/daemon.ts";
import { commandAdd } from "./commands/add.ts";
import { commandStart } from "./commands/start.ts";
import { commandStop } from "./commands/stop.ts";
import { commandAbort } from "./commands/abort.ts";
import { commandClear } from "./commands/clear.ts";
import { commandStatus } from "./commands/status.ts";
import { commandLogs } from "./commands/logs.ts";
import { commandInstall } from "./commands/install.ts";
import { commandReload } from "./commands/reload.ts";

function findDaemonDescriptor(dataDir: string): { port: number; pid: number } | null {
  try {
    const path = `${dataDir}/daemon.json`;
    const raw = Bun.file(path);
    // Synchronously read for CLI use
    const text = Bun.file(path).textSync();
    if (!text) return null;
    return JSON.parse(text) as { port: number; pid: number };
  } catch {
    return null;
  }
}

function probeDaemon(port: number): boolean {
  try {
    const res = Bun.fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function main(args: string[]): Promise<number> {
  const parsed = parseArgs(args);

  const dataDir = getStringFlag(
    parsed.flags,
    "data-dir",
    "TQ_DATA_DIR",
    ".tq",
  );

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

  if (!cmd || cmd === "daemon") {
    const port = parseInt(
      getStringFlag(parsed.flags, "port", "TQ_PORT", "3000"),
      10,
    );
    return await commandDaemon(dataDir, port, parsed.flags);
  }

  // Discover daemon
  const descriptor = findDaemonDescriptor(dataDir);
  let daemonPort = descriptor?.port ?? null;
  if (daemonPort !== null && !probeDaemon(daemonPort)) {
    daemonPort = null;
  }

  switch (cmd) {
    case "add":
      return await commandAdd(dataDir, daemonPort, parsed.positional.slice(1), parsed.flags);
    case "start":
      return await commandStart(daemonPort, parsed.positional[1], parsed.flags, dataDir);
    case "stop":
      return await commandStop(daemonPort, parsed.positional[1], parsed.flags, dataDir);
    case "abort":
      return await commandAbort(daemonPort, parsed.positional[1], parsed.flags, dataDir);
    case "clear":
      return await commandClear(dataDir, daemonPort, parsed.positional.slice(1), parsed.flags);
    case "status":
      return await commandStatus(dataDir, daemonPort, parsed.flags);
    case "logs":
      return await commandLogs(dataDir, daemonPort, parsed.positional.slice(1), parsed.flags);
    case "install":
      return await commandInstall(dataDir, daemonPort, parsed.positional.slice(1), parsed.flags);
    case "reload":
      if (daemonPort === null) {
        console.error("Error: daemon is not running. Start it with `tq daemon` first.");
        return 1;
      }
      return await commandReload(daemonPort, parsed.flags);
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
