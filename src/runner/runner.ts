/**
 * Task runner loop.
 *
 * Picks PENDING instances from PROCESSING queues in FIFO order,
 * respecting per-queue concurrency, and marks them as RUNNING.
 *
 * Actual task execution (loading entrypoint, running function,
 * console interception, log capture) is in ticket 05.
 */

import type { DB } from "../db/database.ts";
import {
  checkDrained,
} from "./queue-state.ts";
import {
  getPendingInstances,
  getRunningInstances,
  getTask,
} from "../db/queries.ts";
import { executeTask } from "./execution.ts";
import { resolveDataDir } from "../db/database.ts";

export interface RunnerConfig {
  pollIntervalMs: number;
  dataDir: string;
}

const DEFAULT_CONFIG: RunnerConfig = {
  pollIntervalMs: 1000,
  dataDir: ".tq",
};

export function createRunner(config: Partial<RunnerConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const dbConfig = resolveDataDir(cfg.dataDir);

  return {
    /**
     * Run one iteration of the runner loop.
     * Returns the number of instances launched.
     */
    async runOnce(db: DB): Promise<number> {
      let launched = 0;

      // Get all PROCESSING queues
      const queues = db.query<{ id: string; concurrency: number }>(
        "SELECT id, concurrency FROM queues WHERE state = 'PROCESSING' ORDER BY id",
      ).all();

      for (const queue of queues) {
        // Check concurrency
        const running = getRunningInstances(db, queue.id);
        if (running.length >= queue.concurrency) continue;

        // Get pending instances (FIFO by id)
        const pending = getPendingInstances(db, queue.id);
        if (pending.length === 0) continue;

        // Launch as many as concurrency allows
        const slotsAvailable = queue.concurrency - running.length;
        const toLaunch = Math.min(slotsAvailable, pending.length);

        for (let i = 0; i < toLaunch; i++) {
          const instance = pending[i];
          const task = getTask(db, queue.id);
          if (!task) continue;

          // Parse the input JSON
          let input: unknown = {};
          try {
            input = JSON.parse(instance.input);
          } catch {
            input = instance.input;
          }

          // Execute the task
          executeTask(
            db,
            instance.id,
            {
              id: task.id,
              entryPoint: `file://${task.id}`, // Will be resolved properly in ticket 08
              timeoutMs: task.timeout_ms,
            },
            input,
            new AbortController().signal,
            dbConfig.logDir,
          ).catch(err => {
            console.error(`Task execution error for instance ${instance.id}:`, err);
          });

          launched++;
        }
      }

      // Check for drained queues
      for (const queue of queues) {
        checkDrained(db, queue.id);
      }

      return launched;
    },

    /**
     * Run continuously, polling for work.
     */
    async runContinuous(db: DB): Promise<void> {
      while (true) {
        await this.runOnce(db);
        await Bun.sleep(cfg.pollIntervalMs);
      }
    },
  };
}
