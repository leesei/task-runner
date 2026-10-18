/**
 * `tq status` command.
 *
 * Shows queue status. Works offline (direct SQLite) when daemon is not running.
 * When daemon is reachable, could use API (ticket 08) but offline works fine.
 */
import { openDatabase, closeDatabase } from "../../db/database.ts";
import { getAllQueues, getQueueCounts, getTotalCounts } from "../../db/queries.ts";

export async function commandStatus(
  dataDir: string,
  _daemonPort: number | null,
  _flags: Record<string, string | true>,
): Promise<number> {
  // Always use offline mode for status (direct SQLite read)
  // This works whether or not the daemon is running

  let db;
  try {
    db = openDatabase(`${dataDir}/taskrunner.db`);
  } catch (err: any) {
    // Database may not exist yet — that's OK, no queues registered
    if (err.message.includes("unable to open") || err.message.includes("no such file")) {
      console.log("No database found. Run `tq daemon` first to create one.");
      return 0;
    }
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const queues = getAllQueues(db);
    const totals = getTotalCounts(db);

    if (queues.length === 0) {
      console.log("No queues registered.");
      return 0;
    }

    console.log(`Queue      State       Concurrency  Running  Pending  Succeeded  Failed  Total`);
    console.log(`----       -----       -----------  -------  -------  ---------  ------  -----`);

    for (const queue of queues) {
      const counts = getQueueCounts(db, queue.id);
      console.log(
        `${queue.id.padEnd(10)} ${queue.state.padEnd(10)} ` +
        `${String(queue.concurrency).padEnd(11)} ` +
        `${String(counts.running).padEnd(7)} ` +
        `${String(counts.pending).padEnd(7)} ` +
        `${String(counts.succeeded).padEnd(9)} ` +
        `${String(counts.failed).padEnd(6)} ` +
        `${String(counts.running + counts.pending + counts.succeeded + counts.failed).padEnd(5)}`
      );
    }

    console.log(`\nTotal: ${totals.total} instances (${totals.running} running, ${totals.pending} pending, ${totals.succeeded} succeeded, ${totals.failed} failed)`);
  } finally {
    closeDatabase(db);
  }

  return 0;
}
