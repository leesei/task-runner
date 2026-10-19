/**
 * `tq logs <instance-id>` command.
 *
 * Shows instance logs. When daemon is reachable, fetches from HTTP API.
 * Otherwise reads the log file directly from the data directory.
 */

import { resolveDataDir, openDatabase, closeDatabase } from "../../db/database.ts";
import { getInstance } from "../../db/queries.ts";
import { readLogFile } from "../../db/logs.ts";

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
  daemonPort: number | null,
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

  // If daemon is reachable, fetch logs from API
  if (daemonPort !== null) {
    try {
      const res = await fetch(
        `http://localhost:${daemonPort}/api/instances/${instanceId}/log`,
      );
      if (res.ok) {
        const records = (await res.json()) as { timestamp: string; stream: string; text: string }[];
        console.log(`Logs for instance ${instanceId}:`);
        printRecords(records);
        return 0;
      }
      const errBody = await res.text();
      console.error(`Daemon returned ${res.status}: ${errBody}`);
      return 1;
    } catch {
      // Fall through to offline path
    }
  }

  // Offline path: read log file directly
  const dbConfig = resolveDataDir(dataDir);
  let db;
  try {
    db = openDatabase(dbConfig.dbPath);
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const instance = getInstance(db, instanceId);
    if (!instance) {
      console.error(`Instance not found: ${instanceId}`);
      return 2;
    }

    if (!instance.log_path) {
      console.log(`Logs for instance ${instanceId}:`);
      console.log("(no logs — instance has no log file)");
      return 0;
    }

    const records = readLogFile(instance.log_path);
    console.log(`Logs for instance ${instanceId}:`);
    printRecords(records);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  } finally {
    closeDatabase(db);
  }
}
