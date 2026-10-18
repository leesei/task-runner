/**
 * Queue control operations.
 *
 * start: queue enters PROCESSING and drains PENDING in enqueue order
 * stop: stop launching new instances, let RUNNING finish, queue ends STOPPED
 * abort: signal RUNNING instances, return them to PENDING with partial logs,
 *        leave queue STOPPED; does not start pending work
 * clear: delete SUCCESS instances and their log files
 * clear --all: delete all finished instances and logs; refuses if RUNNING
 */

import type { DB } from "../db/database.ts";
import {
  startQueue,
  stopQueue,
  abortQueue,
} from "../runner/queue-state.ts";
import { getQueue } from "../db/queries.ts";
import {
  deleteSuccessInstances,
  deleteFinishedInstances,
  getQueueCounts,
  getRunningInstances,
} from "../db/queries.ts";
import type { QueueState } from "../db/schema.ts";

export interface ControlResult {
  success: boolean;
  message: string;
  queueState?: QueueState;
  runningCount?: number;
  pendingCount?: number;
  deletedCount?: number;
  runningIds?: number[];
}

export function controlStart(db: DB, queueId: string): ControlResult {
  const queue = getQueue(db, queueId);
  if (!queue) {
    return { success: false, message: `Queue not found: ${queueId}` };
  }

  const success = startQueue(db, queueId);
  if (!success) {
    return { success: false, message: `Cannot start queue ${queueId}: invalid state transition` };
  }

  const counts = getQueueCounts(db, queueId);
  return {
    success: true,
    message: `Queue ${queueId} started`,
    queueState: "PROCESSING",
    runningCount: counts.running,
    pendingCount: counts.pending,
  };
}

export function controlStop(db: DB, queueId: string): ControlResult {
  const queue = getQueue(db, queueId);
  if (!queue) {
    return { success: false, message: `Queue not found: ${queueId}` };
  }

  const success = stopQueue(db, queueId);
  if (!success) {
    return { success: false, message: `Cannot stop queue ${queueId}: invalid state transition` };
  }

  const counts = getQueueCounts(db, queueId);
  return {
    success: true,
    message: `Queue ${queueId} stopping (let running finish)`,
    queueState: "STOPPED",
    runningCount: counts.running,
    pendingCount: counts.pending,
  };
}

export function controlAbort(db: DB, queueId: string): ControlResult {
  const queue = getQueue(db, queueId);
  if (!queue) {
    return { success: false, message: `Queue not found: ${queueId}` };
  }

  const running = getRunningInstances(db, queueId);
  const runningIds = running.map(r => r.id);

  const success = abortQueue(db, queueId);
  if (!success) {
    return { success: false, message: `Cannot abort queue ${queueId}: invalid state transition` };
  }

  return {
    success: true,
    message: `Queue ${queueId} aborted: ${runningIds.length} instance(s) returned to PENDING`,
    queueState: "STOPPED",
    runningCount: 0,
    pendingCount: runningIds.length,
    runningIds,
  };
}

export function controlClear(db: DB, queueId: string, all: boolean): ControlResult {
  const queue = getQueue(db, queueId);
  if (!queue) {
    return { success: false, message: `Queue not found: ${queueId}` };
  }

  if (all) {
    const result = deleteFinishedInstances(db, queueId);
    if (result.running_ids.length > 0) {
      return {
        success: false,
        message: `Cannot clear --all: ${result.running_ids.length} instance(s) are RUNNING: ${result.running_ids.join(", ")}`,
        runningIds: result.running_ids,
      };
    }
    return {
      success: true,
      message: `Cleared ${result.deleted} finished instance(s) from ${queueId}`,
      deletedCount: result.deleted,
    };
  }

  const deleted = deleteSuccessInstances(db, queueId);
  return {
    success: true,
    message: `Cleared ${deleted} successful instance(s) from ${queueId}`,
    deletedCount: deleted,
  };
}
