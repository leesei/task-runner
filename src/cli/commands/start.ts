/**
 * `tq start <queue>` command.
 *
 * Calls the shared core to put the queue into PROCESSING. The daemon must be
 * live so the runner can drain it; liveness is checked from the descriptor pid,
 * never over HTTP.
 */

import { startQueue } from "../../core/service.ts";
import { closeDatabase, openDatabase, resolveDataDir } from "../../db/database.ts";

export async function commandStart(
  dataDir: string,
  daemonRunning: boolean,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq start <queue>");
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
    const result = startQueue(db, queueId);
    if (!result.success) {
      console.error(result.message);
      return 1;
    }
    console.log(result.message);
    return 0;
  } finally {
    closeDatabase(db);
  }
}
