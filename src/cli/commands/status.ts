/**
 * `tq status` command.
 *
 * Reads queue state through the shared core. It never calls the daemon HTTP
 * API, so it works with the daemon stopped.
 */
import {
  closeDatabase,
  openDatabase,
  resolveDataDir,
} from "../../db/database.ts";
import { listQueues } from "../../core/service.ts";
import { formatTable } from "../table.ts";

export async function commandStatus(
  dataDir: string,
  _flags: Record<string, string | true>,
): Promise<number> {
  const dbConfig = resolveDataDir(dataDir);
  let db;
  try {
    db = openDatabase(dbConfig.dbPath);
  } catch (err: any) {
    // Database may not exist yet — that's OK, no queues registered
    if (
      err.message.includes("unable to open") ||
      err.message.includes("no such file")
    ) {
      console.log("No database found. Run `tq daemon` first to create one.");
      return 0;
    }
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const queues = listQueues(db);

    if (queues.length === 0) {
      console.log("No queues registered.");
      return 0;
    }

    console.log(
      formatTable([
        [
          "Queue",
          "State",
          "Concurrency",
          "Running",
          "Pending",
          "Succeeded",
          "Failed",
          "Total",
        ],
        ...queues.map((queue) => {
          const total =
            queue.running +
            queue.pending +
            queue.succeeded +
            queue.failed;
          return [
            queue.id,
            queue.state,
            String(queue.concurrency),
            String(queue.running),
            String(queue.pending),
            String(queue.succeeded),
            String(queue.failed),
            String(total),
          ];
        }),
      ]),
    );

    const totals = queues.reduce(
      (acc, queue) => ({
        total: acc.total + queue.running + queue.pending + queue.succeeded + queue.failed,
        running: acc.running + queue.running,
        pending: acc.pending + queue.pending,
        succeeded: acc.succeeded + queue.succeeded,
        failed: acc.failed + queue.failed,
      }),
      { total: 0, running: 0, pending: 0, succeeded: 0, failed: 0 },
    );

    console.log(
      `\nTotal: ${totals.total} instances (${totals.running} running, ${totals.pending} pending, ${totals.succeeded} succeeded, ${totals.failed} failed)`,
    );
  } finally {
    closeDatabase(db);
  }

  return 0;
}
