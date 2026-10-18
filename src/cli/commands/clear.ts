/**
 * `tq clear [--all] <queue>` command.
 *
 * Clears finished instances and their log files.
 * clear: deletes SUCCESS instances
 * clear --all: deletes all finished instances (refuses if RUNNING)
 * Works offline (direct SQLite) when daemon is not reachable.
 */

import { controlClear } from "../../control/queue-control.ts";
import { openDatabase, closeDatabase, resolveDataDir } from "../../db/database.ts";

export async function commandClear(
  dataDir: string,
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

  // Try daemon API first; fall back to offline SQLite
  if (daemonPort !== null) {
    try {
      const qs = all ? "?clear=all" : "?clear=success";
      const res = await fetch(
        `http://localhost:${daemonPort}/api/queues/${encodeURIComponent(queueId)}${qs}`,
        { method: "POST" },
      );
      if (res.ok) {
        const body = (await res.json()) as { success: boolean; deleted: number; queueId: string };
        console.log(resultMessage(body, all));
        if (body.deleted) console.log(`Deleted ${body.deleted} log file(s)`);
        return 0;
      }
      const errBody = await res.text();
      console.error(`Daemon returned ${res.status}: ${errBody}`);
      // fall through to offline if API refused (e.g. RUNNING instances)
    } catch {
      // fall through to offline
    }
  }

  // Offline path: direct SQLite
  const dbConfig = resolveDataDir(dataDir);
  let db;
  try {
    db = openDatabase(dbConfig.dbPath);
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

function resultMessage(body: { success: boolean; deleted: number; queueId: string }, all: boolean): string {
  if (all) {
    return `Cleared ${body.deleted} finished instance(s) from ${body.queueId}`;
  }
  return `Cleared ${body.deleted} successful instance(s) from ${body.queueId}`;
}
