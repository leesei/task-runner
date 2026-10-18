/**
 * `tq status` command.
 *
 * Shows queue status. Works offline (direct SQLite) when daemon is not running.
 * When daemon is reachable, could use API (ticket 08) but offline works fine.
 */
import { resolveDataDir, openDatabase, closeDatabase } from "../../db/database.ts";
import { getAllQueues, getQueueCounts, getTotalCounts } from "../../db/queries.ts";

export async function commandStatus(
  dataDir: string,
  daemonPort: number | null,
  _flags: Record<string, string | true>,
): Promise<number> {
  // Try daemon API first; fall back to offline SQLite read
  if (daemonPort !== null) {
    try {
      const res = await fetch(`http://localhost:${daemonPort}/api/queues`);
      if (res.ok) {
        const queues = (await res.json()) as Array<{
          id: string;
          state: string;
          running: number;
          pending: number;
          succeeded: number;
          failed: number;
        }>;
        console.log(`Status via daemon (port ${daemonPort}):`);
        console.log(`Queue      State       Running  Pending  Succeeded  Failed`);
        console.log(`----       -----       -------  -------  ---------  ------`);
        for (const q of queues) {
          console.log(
            `${q.id.padEnd(10)} ${q.state.padEnd(10)} ` +
            `${String(q.running).padEnd(7)} ` +
            `${String(q.pending).padEnd(7)} ` +
            `${String(q.succeeded).padEnd(9)} ` +
            `${String(q.failed).padEnd(6)}`,
          );
        }
        const total = {
          total: queues.reduce((s, q) => s + q.running + q.pending + q.succeeded + q.failed, 0),
          running: queues.reduce((s, q) => s + q.running, 0),
          pending: queues.reduce((s, q) => s + q.pending, 0),
          succeeded: queues.reduce((s, q) => s + q.succeeded, 0),
          failed: queues.reduce((s, q) => s + q.failed, 0),
        };
        console.log(`\nTotal: ${total.total} instances (${total.running} running, ${total.pending} pending, ${total.succeeded} succeeded, ${total.failed} failed)`);
        return 0;
      }
    } catch {
      // Fall through to offline path
    }
  }

  // Offline path: read DB directly
  const dbConfig = resolveDataDir(dataDir);
  let db;
  try {
    db = openDatabase(dbConfig.dbPath);
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
