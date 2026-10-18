/**
 * CLI argument parsing for `tq`.
 *
 * Supports:
 * - Subcommands: daemon, add, start, stop, abort, clear, status, logs, install, reload
 * - Global flags: --data-dir, --port, --help
 * - Per-command flags (daemon: --data-dir, --port)
 *
 * Resolution order: CLI flag > env var > default.
 */

export interface ParsedArgs {
  subcommands: string[];
  flags: Record<string, string | true>;
  positional: string[];
  raw: string[];
}

export function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  let i = 0;

  // Skip program name(s).
  // When run via shebang (./tq), argv is [bun, ./tq, ...args] → skip 2.
  // When run via bun run, argv is [bun, script.ts, ...args] → skip 1.
  // Heuristic: skip 1, then if the next arg looks like a program path, skip it too.
  if (args.length > i) i++;
  if (args.length > i && (args[i]!.includes("/") || args[i]!.includes("\\"))) i++;

  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      flags["help"] = true;
      i++;
    } else if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx >= 0) {
        // --key=value
        const key = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        flags[key] = value;
        i++;
      } else {
        // --key (possibly followed by value as next arg)
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          // --key value
          flags[key] = next;
          i += 2;
        } else {
          // --flag (boolean)
          flags[key] = true;
          i++;
        }
      }
    } else {
      positional.push(arg);
      i++;
    }
  }

  return { subcommands: positional, flags, positional, raw: args };
}

export function getStringFlag(
  flags: Record<string, string | true>,
  name: string,
  envVar: string,
  defaultValue: string,
): string {
  if (flags[name] !== undefined && flags[name] !== true) {
    return flags[name]!;
  }
  const env = process.env[envVar];
  if (env !== undefined) return env;
  return defaultValue;
}

export function getPortFlag(
  flags: Record<string, string | true>,
  name: string,
  envVar: string,
  defaultValue: number,
): number {
  const raw = getStringFlag(flags, name, envVar, String(defaultValue));
  const port = parseInt(raw, 10);
  if (isNaN(port) || port < 0) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

export function printUsage(): void {
  console.log(`
tq — Task Runner CLI

Usage:
  tq daemon                  Start the daemon
  tq add <task> [context]    Enqueue a task instance
  tq start <queue>           Start draining a queue
  tq stop <queue>            Stop a queue
  tq abort <queue>           Abort running instances
  tq clear [--all] <queue>   Clear finished instances
  tq status                  Show queue status
  tq logs <instance-id>      Show instance logs
  tq install <package>       Install a task package
  tq reload                  Reload task definitions

Global flags:
  --data-dir <path>   Data directory (default: .tq/, or TQ_DATA_DIR)
  --port <port>       HTTP port (default: 3000, or TQ_PORT)
  --help, -h          Show this help

Environment variables:
  TQ_DATA_DIR   Data directory path
  TQ_PORT       HTTP port number
`);
}

export function printDaemonUsage(): void {
  console.log(`
tq daemon — Start the Task Runner daemon

Starts the HTTP server, dashboard, and runner loop. Queues autostart on launch.

Usage:
  tq daemon [--data-dir <path>] [--port <port>]

Flags:
  --data-dir <path>   Data directory (default: .tq/ in cwd, or TQ_DATA_DIR)
  --port <port>       HTTP port (default: 3000, or TQ_PORT). Use 0 for ephemeral.
  --help, -h          Show this help

The daemon writes a descriptor file (daemon.json) in the data directory with
its pid, port, and start time. Other tq commands use this to find the daemon.

Examples:
  tq daemon                          # default: localhost:3000, .tq/
  tq daemon --port 0                 # ephemeral port (for tests)
  tq daemon --data-dir /tmp/tq       # custom data directory
  TQ_PORT=8080 tq daemon             # via environment variable
`);
}
