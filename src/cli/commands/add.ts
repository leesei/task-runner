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

import { CoreError } from "../../core/service.ts";
import { openCliCore } from "../core.ts";
import { buildContext, UsageError } from "../context.ts";

const ADD_USAGE = "Usage: tq add [--id <id>] <task> [context]";

function getVerboseLevel(flags: Record<string, string | true>): number {
  const v = flags["verbose"];
  if (typeof v === "string") return Number(v) || 0;
  if (v === true) return 1;
  return 0;
}

export async function commandAdd(
  dataDir: string,
  args: string[],
  flags: Record<string, string | true>,
  cwd: string = process.cwd(),
  projectRoot: string = cwd,
): Promise<number> {
  if (args.length === 0) {
    console.error(ADD_USAGE);
    return 2;
  }

  const taskId = args[0]!;
  const verbose = getVerboseLevel(flags);

  let userId: string | undefined;
  const rawId = flags["id"];
  if (rawId !== undefined) {
    if (rawId === true || rawId.trim().length === 0) {
      console.error("Error: --id must be a non-empty string");
      console.error(ADD_USAGE);
      return 2;
    }
    userId = rawId;
  }

  let cli;
  try {
    cli = openCliCore(dataDir, { bootstrap: true, projectRoot });
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    // Offline `add` may be the first command against a fresh project. Reload
    // discovery when the task is not yet registered so the CLI does not
    // require a daemon just to enqueue the first instance.
    let schema: object | null;
    try {
      schema = cli.core.getTaskInputSchema(taskId);
    } catch (err) {
      if (err instanceof CoreError && err.code === "TASK_NOT_FOUND") {
        cli.core.reload();
        schema = cli.core.getTaskInputSchema(taskId);
      } else {
        throw err;
      }
    }

    if (verbose >= 1) {
      console.error(`Resolved task: ${taskId}`);
      console.error(`Resolved data directory: ${dataDir}`);
      console.error(`Project root: ${projectRoot}`);
      console.error(`Working directory: ${cwd}`);
    }
    if (verbose >= 2) {
      console.error(`Database path: ${cli.config.dbPath}`);
      console.error(`Schema: ${schema ? JSON.stringify(schema) : "null"}`);
    }

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

    if (verbose >= 1) {
      console.error(`Normalized context: ${JSON.stringify(input)}`);
    }

    const result = cli.core.enqueue(taskId, input, { cwd, userId });
    console.log(`Enqueued instance ${result.id} at ${result.createdAt}`);
    if (result.user_id !== null) {
      console.log(`User id: ${result.user_id}`);
    }
    console.log(`Task: ${taskId}`);
    console.log(`Context: ${JSON.stringify(result.input)}`);
    console.log(`Working directory: ${result.cwd}`);
    return 0;
  } catch (err: any) {
    if (err instanceof CoreError && err.code === "TASK_NOT_FOUND") {
      console.error(`Task not found: ${taskId}`);
      return 2;
    }
    if (err instanceof CoreError && err.code === "INVALID_CWD") {
      console.error(`Invalid working directory: ${err.message}`);
      return 2;
    }
    if (err instanceof CoreError && err.code === "INPUT_SCHEMA_VIOLATION") {
      console.error(`Context validation failed for ${taskId}:`);
      for (const issue of err.issues ?? []) {
        console.error(`  ${issue.path}: ${issue.message}`);
      }
      return 2;
    }
    if (err instanceof CoreError && err.code === "INSTANCE_ID_CONFLICT") {
      console.error(err.message);
      return 2;
    }
    if (err instanceof CoreError && err.code === "INVALID_INSTANCE_ID") {
      console.error(err.message);
      return 2;
    }
    console.error(`Error: ${err.message}`);
    return 1;
  } finally {
    cli.close();
  }
}
