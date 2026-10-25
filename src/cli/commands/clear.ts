/**
 * `tq clear [--all] <queue>` command.
 *
 * Calls the shared core in-process. It never calls the daemon HTTP API, so it
 * works with the daemon stopped.
 *
 * clear: deletes SUCCESS instances
 * clear --all: deletes all finished instances (refuses if RUNNING)
 */

import { CoreError } from "../../core/service.ts";
import { openCliCore } from "../core.ts";

export async function commandClear(
  dataDir: string,
  args: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  // The parser turns `--all` into a boolean flag, but keep the positional
  // fallback for direct callers.
  const positionalAll = args[0] === "--all";
  const all = flags["all"] === true || positionalAll;
  const queueId = positionalAll ? args[1] : args[0];

  if (!queueId) {
    console.error("Usage: tq clear [--all] <queue>");
    return 2;
  }

  let cli;
  try {
    cli = openCliCore(dataDir);
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const result = cli.core.clear(queueId, all);
    console.log(
      `Cleared ${result.deleted} ${all ? "finished" : "successful"} instance(s) from ${queueId}`,
    );
    return 0;
  } catch (err: any) {
    if (err instanceof CoreError && err.code === "QUEUE_NOT_FOUND") {
      console.error(err.message);
      return 2;
    }
    console.error(err.message);
    if (err instanceof CoreError && err.runningIds?.length) {
      console.error(`Running instance ids: ${err.runningIds.join(", ")}`);
    }
    return 1;
  } finally {
    cli.close();
  }
}
