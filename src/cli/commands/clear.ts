/**
 * `tq clear [--all] <queue>` command.
 *
 * Calls the shared core in-process. It never calls the daemon HTTP API, so it
 * works with the daemon stopped.
 *
 * clear: deletes SUCCESS instances
 * clear --all: deletes all finished instances (refuses if RUNNING)
 */

import { clearQueue } from "../../core/service.ts";
import { openDatabase, closeDatabase, resolveDataDir } from "../../db/database.ts";

export async function commandClear(
  dataDir: string,
  args: string[],
  _flags: Record<string, string | true>,
): Promise<number> {
  const all = args[0] === "--all";
  const queueId = all ? args[1] : args[0];

  if (!queueId) {
    console.error("Usage: tq clear [--all] <queue>");
    return 2;
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
    const result = clearQueue(db, queueId, all);
    if (result.success) {
      console.log(result.message);
      if (result.deletedCount !== undefined) {
        console.log(`Deleted ${result.deletedCount} log file(s)`);
      }
      return 0;
    }

    console.error(result.message);
    if (result.runningIds && result.runningIds.length > 0) {
      console.error(`Running instance ids: ${result.runningIds.join(", ")}`);
    }
    return 1;
  } finally {
    closeDatabase(db);
  }
}
