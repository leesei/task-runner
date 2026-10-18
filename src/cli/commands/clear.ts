/**
 * `tq clear [--all] <queue>` command.
 *
 * Clears finished instances and their log files.
 * clear: deletes SUCCESS instances
 * clear --all: deletes all finished instances (refuses if RUNNING)
 */

import { controlClear } from "../../control/queue-control.ts";
import { openDatabase, closeDatabase } from "../../db/database.ts";

export async function commandClear(
  _dataDir: string,
  daemonPort: number | null,
  args: string[],
  _flags: Record<string, string | true>,
): Promise<number> {
  const all = args[0] === "--all";
  const queueId = all ? args[1] : args[0];

  if (!queueId) {
    console.error("Usage: tq clear [--all] <queue>");
    return 2;
  }

  const dataDir = process.env.TQ_DATA_DIR ?? _dataDir ?? ".tq";

  let db;
  try {
    db = openDatabase(`${dataDir}/taskrunner.db`);
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const result = controlClear(db, queueId, all);
    if (result.success) {
      console.log(result.message);
      if (result.deletedCount !== undefined) {
        console.log(`Deleted ${result.deletedCount} log file(s)`);
      }
      return 0;
    } else {
      console.error(result.message);
      if (result.runningIds && result.runningIds.length > 0) {
        console.error(`Running instance ids: ${result.runningIds.join(", ")}`);
      }
      return 1;
    }
  } finally {
    closeDatabase(db);
  }
}
