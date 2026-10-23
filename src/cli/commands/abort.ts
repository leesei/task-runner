/**
 * `tq abort <queue>` command.
 *
 * Writes a durable abort control request through the shared core. The daemon
 * runner consumes it, signals running instances, returns them to PENDING, and
 * leaves the queue STOPPED. No HTTP API call is made.
 */

import { abortQueue } from "../../core/service.ts";
import { closeDatabase, openDatabase, resolveDataDir } from "../../db/database.ts";

export async function commandAbort(
  dataDir: string,
  daemonRunning: boolean,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq abort <queue>");
    return 2;
  }

  if (!daemonRunning) {
    console.error("Error: daemon is not running. Start it with `tq daemon` first.");
    return 1;
  }

  const dbConfig = resolveDataDir(dataDir);
  let db;
  try {
    db = openDatabase(dbConfig.dbPath);
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const result = await abortQueue(db, queueId);
    if (!result.success) {
      console.error(result.message);
      return 1;
    }
    console.log(result.message);
    if (result.runningIds?.length) {
      console.log(`Returned ${result.runningIds.length} instance(s) to PENDING`);
    }
    return 0;
  } finally {
    closeDatabase(db);
  }
}
