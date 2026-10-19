/**
 * `tq add <task> [input]` command.
 *
 * Validates input, enqueues an instance, prints its id.
 * Works offline (direct SQLite) when daemon is not reachable.
 */

import { openDatabase, closeDatabase, resolveDataDir } from "../../db/database.ts";
import { getTask, insertInstance } from "../../db/queries.ts";
import { ensureQueuesForTasks } from "../../runner/queue-state.ts";

function makeInput(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Treat as plain string input
    return raw;
  }
}

export async function commandAdd(
  dataDir: string,
  daemonPort: number | null,
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

  // If daemon is reachable, enqueue through HTTP API
  if (daemonPort !== null) {
    try {
      const res = await fetch(
        `http://localhost:${daemonPort}/api/instances`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: taskId, input }),
        },
      );
      if (res.ok) {
        const body = (await res.json()) as { id: number; task: string; input: unknown };
        console.log(`Enqueued instance ${body.id} on task ${body.task}`);
        console.log(`Input: ${inputJson}`);
        return 0;
      }
      // Non-200: fall through to offline path below
      const errBody = await res.text();
      console.error(`Daemon returned ${res.status}: ${errBody}`);
    } catch {
      // Daemon not reachable — fall through to offline path
    }
  }

  // Offline path: direct SQLite insert
  const dbConfig = resolveDataDir(dataDir);
  let db;
  try {
    db = openDatabase(dbConfig.dbPath);
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const task = getTask(db, taskId)!;
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      return 2;
    }

    ensureQueuesForTasks(db);

    const id = insertInstance(db, taskId, inputJson, null);
    console.log(`Enqueued instance ${id} on task ${taskId}`);
    console.log(`Input: ${inputJson}`);
    console.log("Note: instance will be picked up when daemon processes the queue");
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  } finally {
    closeDatabase(db);
  }
}
