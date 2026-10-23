/**
 * `tq add <task> [context]` command.
 *
 * Calls the shared core in-process. It never uses the daemon HTTP API, so it
 * works with the daemon stopped; the runner picks the instance up on its next
 * poll tick.
 *
 * The CLI owns context parsing (JSON, `@file`, assignments, bare-string
 * convenience) and `format: "path"` resolution. Validation itself stays in the
 * core so the HTTP API rejects exactly the same contexts.
 */

import {
  bootstrapDataDir,
  closeDatabase,
  configureDatabase,
  openDatabase,
  resolveDataDir,
} from "../../db/database.ts";
import {
  CoreError,
  enqueueTask,
  getTaskInputSchema,
} from "../../core/service.ts";
import { buildContext, UsageError } from "../context.ts";

const ADD_USAGE = "Usage: tq add <task> [context]";

export async function commandAdd(
  dataDir: string,
  args: string[],
  _flags: Record<string, string | true>,
  cwd: string = process.cwd(),
): Promise<number> {
  if (args.length === 0) {
    console.error(ADD_USAGE);
    return 2;
  }

  const taskId = args[0]!;

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
    const schema = getTaskInputSchema(db, taskId);

    let input: unknown;
    try {
      input = buildContext(args.slice(1), { schema, cwd });
    } catch (err) {
      if (err instanceof UsageError) {
        console.error(`Error: ${err.message}`);
        console.error(ADD_USAGE);
        return 2;
      }
      throw err;
    }

    const id = enqueueTask(db, taskId, input);
    console.log(`Enqueued instance ${id} on task ${taskId}`);
    console.log(`Input: ${JSON.stringify(input)}`);
    return 0;
  } catch (err: any) {
    if (err instanceof CoreError && err.code === "TASK_NOT_FOUND") {
      console.error(`Task not found: ${taskId}`);
      return 2;
    }
    if (err instanceof CoreError && err.code === "INPUT_SCHEMA_VIOLATION") {
      console.error(`Context validation failed for ${taskId}:`);
      for (const issue of err.issues ?? []) {
        console.error(`  ${issue.path}: ${issue.message}`);
      }
      return 2;
    }
    console.error(`Error: ${err.message}`);
    return 1;
  } finally {
    closeDatabase(db);
  }
}
