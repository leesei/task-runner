/**
 * `tq stop <queue>` command.
 *
 * Calls the shared core to stop launching new instances. The daemon must be
 * live; liveness comes from the descriptor pid, never HTTP.
 */

import { CoreError } from "../../core/service.ts";
import { openCliCore } from "../core.ts";

export async function commandStop(
  dataDir: string,
  daemonRunning: boolean,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq stop <queue>");
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
    const state = cli.core.stop(queueId);
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
