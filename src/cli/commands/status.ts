/**
 * `tq status` command.
 *
 * Reads queue state through the shared core. It never calls the daemon HTTP
 * API, so it works with the daemon stopped.
 */
import { openCliCore } from "../core.ts";
import { formatTable } from "../table.ts";

export async function commandStatus(
  dataDir: string,
  _flags: Record<string, string | true>,
  projectRoot: string = process.cwd(),
): Promise<number> {
  let cli;
  try {
    cli = openCliCore(dataDir, { projectRoot });
  } catch (err: any) {
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
    for (const warning of cli.core.discoveryWarnings()) {
      console.warn(`Warning: ${warning}`);
    }

    const queues = cli.core.listQueues();

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
          return [
            queue.id,
            queue.state,
            String(queue.concurrency),
            String(queue.running),
            String(queue.pending),
            String(queue.succeeded),
            String(queue.failed),
            String(queue.total),
          ];
        }),
      ]),
    );

    const totals = queues.reduce(
      (acc, queue) => ({
        total: acc.total + queue.total,
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
    cli.close();
  }

  return 0;
}
