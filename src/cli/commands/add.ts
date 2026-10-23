/**
 * `tq add <task> [input]` command.
 *
 * Calls the shared core in-process. It never uses the daemon HTTP API, so it
 * works with the daemon stopped; the runner picks the instance up on its next
 * poll tick.
 */

import {
  bootstrapDataDir,
  closeDatabase,
  configureDatabase,
  openDatabase,
  resolveDataDir,
} from "../../db/database.ts";
import { CoreError, enqueueTask } from "../../core/service.ts";

function makeInput(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function commandAdd(
  dataDir: string,
  args: string[],
  _flags: Record<string, string | true>,
): Promise<number> {
  if (args.length === 0) {
    console.error("Usage: tq add <task> [input]");
    return 2;
  }

  const taskId = args[0]!;
  const input = makeInput(args[1]);
  const inputJson = JSON.stringify(input);

  const dbConfig = resolveDataDir(dataDir);
  let db;
  try {
    bootstrapDataDir(dbConfig);
    db = openDatabase(dbConfig.dbPath);
    configureDatabase(db);
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const id = enqueueTask(db, taskId, input);
    console.log(`Enqueued instance ${id} on task ${taskId}`);
    console.log(`Input: ${inputJson}`);
    return 0;
  } catch (err: any) {
    if (err instanceof CoreError && err.code === "TASK_NOT_FOUND") {
      console.error(`Task not found: ${taskId}`);
      return 2;
    }
    console.error(`Error: ${err.message}`);
    return 1;
  } finally {
    closeDatabase(db);
  }
}
