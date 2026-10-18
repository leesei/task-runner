/**
 * Task runner loop.
 *
 * Picks PENDING instances from PROCESSING queues in FIFO order,
 * respecting per-queue concurrency.
 *
 * For each launched instance:
 *   1. Mark as RUNNING with started_at
 *   2. Create an AbortController and pass its signal to the task
 *   3. Execute with timeout enforcement
 *   4. On completion: mark SUCCESS/FAILED, set ended_at/duration
 *   5. On timeout: mark FAILED with reason 'timeout', do NOT return to PENDING
 *   6. On abort: return to PENDING with incremented attempt, preserve partial log
 *
 * Actual task execution (loading entrypoint, running function,
 * console interception, log capture) is in execution.ts.
 */

import type { DB } from "../db/database.ts";
import {
  checkDrained,
} from "./queue-state.ts";
import {
  getPendingInstances,
  getRunningInstances,
  getTask,
  updateInstanceState,
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
      const queues = db.query<{ id: string; concurrency: number }, []>(
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
          if (!instance) continue;
          const task = getTask(db, queue.id);
          if (!task) continue;

          // Parse the input JSON
          let input: unknown = {};
          try {
            input = JSON.parse(instance.input);
          } catch {
            input = instance.input;
          }

          // Mark instance as RUNNING before executing
          updateInstanceState(db, instance.id, "RUNNING");

          // Create an AbortController for this instance
          const controller = new AbortController();

          // Execute the task with timeout and abort handling
          // entrypoint is stored in the tasks table by discovery
          const entryPoint = task.entry_point ?? `file://${task.id}`;
          executeTask(
            db,
            instance.id,
            {
              id: task.id,
              entryPoint,
              timeoutMs: task.timeout_ms,
            },
            input,
            controller.signal,
            dbConfig.logDir,
            () => controller.abort(),
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
