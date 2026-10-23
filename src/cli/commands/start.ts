/**
 * `tq start <queue>` command.
 *
 * Calls the shared core to put the queue into PROCESSING. The daemon must be
 * live so the runner can drain it; liveness is checked from the descriptor pid,
 * never over HTTP.
 */

import { CoreError } from "../../core/service.ts";
import { openCliCore } from "../core.ts";

export async function commandStart(
  dataDir: string,
  daemonRunning: boolean,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq start <queue>");
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
    const state = cli.core.start(queueId);
    console.log(`Queue ${queueId} is ${state}`);
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
