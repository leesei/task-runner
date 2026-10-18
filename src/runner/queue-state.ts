/**
 * Queue state machine and registry.
 *
 * Queue states: IDLE, PROCESSING, STOPPED
 * Transitions:
 *   IDLE ⇄ PROCESSING
 *   PROCESSING → STOPPED (stop, abort)
 *   STOPPED → PROCESSING (start)
 *   PROCESSING → IDLE (drained: nothing running, nothing pending)
 *
 * On daemon start:
 *   - STOPPED queues stay STOPPED
 *   - All other queues enter PROCESSING (autostart)
 */

import type { DB } from "../db/database.ts";
import {
  getQueue,
  updateQueueState,
  ensureQueue,
  getPendingInstances,
  getRunningInstances,
  updateInstanceState,
  getQueueCounts,
} from "../db/queries.ts";
import type { QueueState, InstanceState } from "../db/schema.ts";

export type { QueueState };

export function transitionQueue(
  db: DB,
  queueId: string,
  targetState: QueueState,
): boolean {
  const queue = getQueue(db, queueId);
  if (!queue) return false;

  // Validate transition
  const validTransitions: Record<QueueState, QueueState[]> = {
    IDLE: ["PROCESSING"],
    PROCESSING: ["STOPPED", "IDLE"],
    STOPPED: ["PROCESSING"],
  };

  if (!validTransitions[queue.state]?.includes(targetState)) {
    return false;
  }

  updateQueueState(db, queueId, targetState);
  return true;
}

export function startQueue(db: DB, queueId: string): boolean {
  return transitionQueue(db, queueId, "PROCESSING");
}

export function stopQueue(db: DB, queueId: string): boolean {
  return transitionQueue(db, queueId, "STOPPED");
}

export function abortQueue(db: DB, queueId: string): boolean {
  // First, signal all running instances (they'll be returned to PENDING)
  const running = getRunningInstances(db, queueId);
  for (const instance of running) {
    updateInstanceState(db, instance.id, "PENDING");
  }
  // Then stop the queue
  return transitionQueue(db, queueId, "STOPPED");
}

export function checkDrained(db: DB, queueId: string): boolean {
  const queue = getQueue(db, queueId);
  if (!queue || queue.state !== "PROCESSING") return false;

  const counts = getQueueCounts(db, queueId);
  if (counts.running === 0 && counts.pending === 0) {
    // Queue is drained — transition to IDLE
    updateQueueState(db, queueId, "IDLE");
    return true;
  }
  return false;
}

export function autostartQueuesOnBoot(db: DB): { started: number; stayedStopped: number } {
  const queues = db.query<{ id: string; state: string; concurrency: number }>(
    "SELECT id, state, concurrency FROM queues ORDER BY id",
  ).all();

  let started = 0;
  let stayedStopped = 0;

  for (const queue of queues) {
    if (queue.state === "STOPPED") {
      // STOPPED queues stay STOPPED across restart
      stayedStopped++;
      continue;
    }

    // All other queues enter PROCESSING
    if (queue.state !== "PROCESSING") {
      updateQueueState(db, queue.id, "PROCESSING");
    }
    started++;
  }

  return { started, stayedStopped };
}

export function ensureQueuesForTasks(db: DB): void {
  // Ensure every task has a queue
  const tasks = db.query<{ id: string; concurrency: number }>(
    "SELECT id, concurrency FROM tasks",
  ).all();

  for (const task of tasks) {
    ensureQueue(db, task.id, task.concurrency);
  }
}
