/**
 * `tq stop <queue>` command.
 *
 * Stops a queue: no new instances launched, running instances finish.
 */

import { controlStop } from "../../control/queue-control.ts";
import { openDatabase, closeDatabase } from "../../db/database.ts";

export async function commandStop(
  daemonPort: number | null,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
  dataDir: string,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq stop <queue>");
    return 2;
  }

  // If daemon is reachable, use HTTP API (ticket 08)
  // For now, operate directly on SQLite
  if (daemonPort === null) {
    console.error("Warning: daemon not detected, operating on SQLite directly");
  }

  let db;
  try {
    db = openDatabase(`${dataDir}/taskrunner.db`);
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const result = controlStop(db, queueId);
    if (result.success) {
      console.log(result.message);
      return 0;
    } else {
      console.error(result.message);
      return 1;
    }
  } finally {
    closeDatabase(db);
  }
}
