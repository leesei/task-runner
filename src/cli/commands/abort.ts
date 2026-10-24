/**
 * `tq abort <queue>` command.
 *
 * Writes a durable abort control request through the shared core. The daemon
 * runner consumes it, signals running instances, returns them to PENDING, and
 * leaves the queue STOPPED. No HTTP API call is made.
 */

import { CoreError } from "../../core/service.ts";
import { openCliCore } from "../core.ts";

export async function commandAbort(
  dataDir: string,
  daemonRunning: boolean,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq abort <queue>");
    return 2;
  }

  if (!daemonRunning) {
    console.error("Error: daemon is not running. Start it with `tq daemon` first.");
    return 1;
  }

  let cli;
  try {
    cli = openCliCore(dataDir);
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const result = await cli.core.abort(queueId);
    console.log(
      `Queue ${queueId} aborted: ${result.cancelled.length} instance(s) returned to PENDING`,
    );
    console.log(`Queue ${queueId} is ${result.queueState}`);
    return 0;
  } catch (err: any) {
    if (err instanceof CoreError && err.code === "QUEUE_NOT_FOUND") {
      console.error(err.message);
      return 2;
    }
    console.error(err.message);
    return 1;
  } finally {
    cli.close();
  }
}
