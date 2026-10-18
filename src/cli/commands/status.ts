/**
 * `tq status` command.
 *
 * Shows queue status. Works offline (direct SQLite) when daemon is not running.
 */
export async function commandStatus(
  dataDir: string,
  daemonPort: number | null,
  _flags: Record<string, string | true>,
): Promise<number> {
  // If daemon is reachable, use API (implemented in ticket 08/09)
  if (daemonPort !== null) {
    console.log("Status via daemon API (not yet implemented - ticket 08)");
    return 0;
  }

  // Offline mode: read directly from SQLite
  const { openDatabase, closeDatabase } = await import("../../db/database.ts");
  const { getAllQueues, getQueueCounts, getTotalCounts } = await import("../../db/queries.ts");

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
