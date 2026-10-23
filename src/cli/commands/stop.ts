/**
 * `tq stop <queue>` command.
 *
 * Calls the shared core to stop launching new instances. The daemon must be
 * live; liveness comes from the descriptor pid, never HTTP.
 */

import { stopQueue } from "../../core/service.ts";
import { closeDatabase, openDatabase, resolveDataDir } from "../../db/database.ts";

export async function commandStop(
  dataDir: string,
  daemonRunning: boolean,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq stop <queue>");
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
    const result = stopQueue(db, queueId);
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
