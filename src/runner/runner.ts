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
import { resolveDataDir } from "../db/database.ts";
import { DEFAULT_DATA_DIR_NAME } from "../defaults.ts";
import {
  getInstance,
  getPendingControlRequests,
  getPendingInstances,
  getQueue,
  getRunningInstances,
  getTask,
  incrementAttempt,
  markControlRequestConsumed,
  updateInstanceState,
  updateQueueState,
} from "../db/queries.ts";
import { executeTask } from "./execution.ts";
import { checkDrained } from "./queue-state.ts";

export interface RunnerConfig {
  pollIntervalMs: number;
  dataDir: string;
  onReload?: () => void | Promise<void>;
}

const DEFAULT_CONFIG: RunnerConfig = {
  pollIntervalMs: 1000,
  dataDir: DEFAULT_DATA_DIR_NAME,
};

export function createRunner(config: Partial<RunnerConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const dbConfig = resolveDataDir(cfg.dataDir);
  const controllers = new Map<number, AbortController>();

  async function processControlRequests(db: DB): Promise<void> {
    const requests = getPendingControlRequests(db);

    for (const request of requests) {
      if (request.kind === "abort") {
        let instanceIds: number[] = [];
        try {
          const parsed = JSON.parse(request.instance_ids ?? "[]") as unknown;
          if (Array.isArray(parsed)) {
            instanceIds = parsed.filter((id): id is number => typeof id === "number");
          }
        } catch {
          instanceIds = [];
        }

        for (const instanceId of instanceIds) {
          // Move the instance out of RUNNING before firing the signal: a task
          // may call done() synchronously from its abort handler, and that
          // late completion must not win over the abort.
          const instance = getInstance(db, instanceId);
          if (instance?.state === "RUNNING") {
            incrementAttempt(db, instanceId);
            updateInstanceState(db, instanceId, "PENDING");
          }

          const controller = controllers.get(instanceId);
          controller?.abort();
          controllers.delete(instanceId);
        }

        if (request.queue_id) {
          const queue = getQueue(db, request.queue_id);
          if (queue && queue.state !== "STOPPED") {
            updateQueueState(db, request.queue_id, "STOPPED");
          }
        }
      } else if (request.kind === "reload") {
        try {
          await cfg.onReload?.();
        } catch (err) {
          console.error("Reload request failed:", err);
        }
      }

      markControlRequestConsumed(db, request.id);
    }
  }

  return {
    /**
     * Run one iteration of the runner loop.
     * Returns the number of instances launched.
     */
    async runOnce(db: DB): Promise<number> {
      await processControlRequests(db);

      let launched = 0;

      // Get all PROCESSING queues
      const queues = db
        .query<
          { id: string; concurrency: number },
          []
        >("SELECT id, concurrency FROM queues WHERE state = 'PROCESSING' ORDER BY id")
        .all();

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
          controllers.set(instance.id, controller);

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
          )
            .catch((err) => {
              console.error(
                `Task execution error for instance ${instance.id}:`,
                err,
              );
            })
            .finally(() => {
              controllers.delete(instance.id);
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
