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
  updateInstanceState,
} from "../db/queries.ts";

export interface RunnerConfig {
  pollIntervalMs: number;
}

const DEFAULT_CONFIG: RunnerConfig = {
  pollIntervalMs: 1000,
};

export function createRunner(db: DB, config: Partial<RunnerConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    /**
     * Run one iteration of the runner loop.
     * Returns the number of instances launched.
     */
    async runOnce(): Promise<number> {
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
          // Mark as RUNNING
          updateInstanceState(db, instance.id, "RUNNING");
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
    async runContinuous(): Promise<void> {
      while (true) {
        await this.runOnce();
        await Bun.sleep(cfg.pollIntervalMs);
      }
    },
  };
}
