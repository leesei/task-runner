/**
 * `tq logs <instance-id>` command.
 *
 * Reads the instance log through the shared core. It never calls the daemon
 * HTTP API, so it works with the daemon stopped.
 */

import { openCliCore } from "../core.ts";

function printRecords(records: { timestamp: string; stream: string; text: string }[]): void {
  if (records.length === 0) {
    console.log("(no logs)");
    return;
  }
  for (const r of records) {
    const stream = r.stream === "stderr" ? "[err] " : "      ";
    console.log(`${r.timestamp} ${stream}${r.text}`);
  }
}

export async function commandLogs(
  dataDir: string,
  args: string[],
  _flags: Record<string, string | true>,
): Promise<number> {
  if (args.length === 0) {
    console.error("Usage: tq logs <instance-id>");
    return 2;
  }

  const instanceId = parseInt(args[0]!, 10);
  if (isNaN(instanceId) || instanceId <= 0) {
    console.error("Error: invalid instance id");
    return 2;
  }

  let cli;
  try {
    cli = openCliCore(dataDir);
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const log = cli.core.readInstanceLog(instanceId);
    if (!log) {
      console.error(`Instance not found: ${instanceId}`);
      return 2;
    }

    console.log(`Logs for instance ${instanceId}:`);
    if (!log.instance.log_path) {
      console.log("(no logs — instance has no log file)");
      return 0;
    }

    printRecords(log.records);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  } finally {
    cli.close();
  }
}
