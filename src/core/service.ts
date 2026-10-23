/**
 * Core task-runner operations.
 *
 * The core is transport-independent: the CLI calls these functions in-process
 * and the daemon's HTTP API wraps the same functions. It must not fetch, print
 * CLI output, or build HTTP responses.
 */

import type { DB } from "../db/database.ts";
import {
  controlClear,
  controlStart,
  controlStop,
} from "../control/queue-control.ts";
import type { ControlResult } from "../control/queue-control.ts";
import {
  ensureQueue,
  getAllQueues,
  getAllTasks,
  getControlRequest,
  getInstance,
  getQueue,
  getQueueCounts,
  getRunningInstances,
  getTask,
  insertControlRequest,
  insertInstance,
  updateQueueState,
} from "../db/queries.ts";
import type { InstanceRow } from "../db/schema.ts";
import { readLogFile, type LogRecord } from "../db/logs.ts";
import { ensureQueuesForTasks } from "../runner/queue-state.ts";
import { getPackageLocations } from "../tasks/lockfile.ts";
import { loadAllTasks } from "../tasks/discovery.ts";
import {
  parseSchema,
  validateContext,
  type ValidationIssue,
} from "./validation.ts";

export class CoreError extends Error {
  readonly code: string;
  /** Present for INPUT_SCHEMA_VIOLATION. */
  readonly issues?: ValidationIssue[];

  constructor(code: string, message: string, issues?: ValidationIssue[]) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.issues = issues;
  }
}

export interface QueueSummary {
  id: string;
  state: string;
  concurrency: number;
  running: number;
  pending: number;
  succeeded: number;
  failed: number;
}

export interface TaskSummary {
  id: string;
  name: string;
  description: string;
  category: string | null;
  concurrency: number;
  timeout_ms: number;
  has_schema: boolean;
}

export interface InstanceLog {
  instance: InstanceRow;
  records: LogRecord[];
}

const CONTROL_TIMEOUT_MS = 5000;

function waitForControlRequest(db: DB, requestId: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + CONTROL_TIMEOUT_MS;
    const poll = () => {
      const request = getControlRequest(db, requestId);
      if (request?.consumed_at) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

// ─── Tasks and instances ─────────────────────────────────────────────────────

export function enqueueTask(db: DB, taskId: string, input: unknown): number {
  const task = getTask(db, taskId);
  if (!task) {
    throw new CoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  }

  // Validate before touching queue or instance state: a violation creates no
  // instance. CLI and HTTP share this path, so they cannot disagree.
  const { value, issues } = validateContext(task.input_schema, input);
  if (issues.length > 0) {
    throw new CoreError(
      "INPUT_SCHEMA_VIOLATION",
      `Context does not match the schema for ${taskId}`,
      issues,
    );
  }

  ensureQueue(db, taskId, task.concurrency);
  const queue = getQueue(db, taskId);
  if (queue?.state === "IDLE") {
    updateQueueState(db, taskId, "PROCESSING");
  }

  return insertInstance(db, taskId, JSON.stringify(value), null);
}

/**
 * The parsed input schema for a task, or null when it has none.
 *
 * The CLI needs the schema before enqueueing to wrap a bare argument and to
 * resolve `format: "path"` values; the core still validates the final value.
 */
export function getTaskInputSchema(db: DB, taskId: string): object | null {
  const task = getTask(db, taskId);
  if (!task) {
    throw new CoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  }
  return parseSchema(task.input_schema);
}

export function listQueues(db: DB): QueueSummary[] {
  return getAllQueues(db).map((queue) => {
    const counts = getQueueCounts(db, queue.id);
    return {
      id: queue.id,
      state: queue.state,
      concurrency: queue.concurrency,
      running: counts.running,
      pending: counts.pending,
      succeeded: counts.succeeded,
      failed: counts.failed,
    };
  });
}

export function getQueueSummary(db: DB, queueId: string): QueueSummary | null {
  const queue = getQueue(db, queueId);
  if (!queue) return null;
  const counts = getQueueCounts(db, queueId);
  return {
    id: queue.id,
    state: queue.state,
    concurrency: queue.concurrency,
    running: counts.running,
    pending: counts.pending,
    succeeded: counts.succeeded,
    failed: counts.failed,
  };
}

export function listTasks(db: DB): TaskSummary[] {
  return getAllTasks(db).map((task) => ({
    id: task.id,
    name: task.name,
    description: task.description,
    category: task.category,
    concurrency: task.concurrency,
    timeout_ms: task.timeout_ms,
    has_schema: task.input_schema !== null,
  }));
}

export function readInstanceLog(db: DB, instanceId: number): InstanceLog | null {
  const instance = getInstance(db, instanceId);
  if (!instance) return null;
  const records = instance.log_path ? readLogFile(instance.log_path) : [];
  return { instance, records };
}

// ─── Queue control ───────────────────────────────────────────────────────────

export {
  controlClear as clearQueue,
  controlStart as startQueue,
  controlStop as stopQueue,
};

/**
 * Abort is daemon-directed: running executions live in the daemon process, so
 * the core records a durable request and waits for the runner to consume it.
 */
export async function abortQueue(
  db: DB,
  queueId: string,
): Promise<ControlResult> {
  const queue = getQueue(db, queueId);
  if (!queue) {
    return { success: false, message: `Queue not found: ${queueId}` };
  }

  const runningIds = getRunningInstances(db, queueId).map((i) => i.id);
  const requestId = insertControlRequest(db, "abort", queueId, runningIds);

  if (!(await waitForControlRequest(db, requestId))) {
    return {
      success: false,
      message: `Timed out waiting for the daemon to process the abort request for ${queueId}`,
      runningIds,
    };
  }

  const counts = getQueueCounts(db, queueId);
  return {
    success: true,
    message: `Queue ${queueId} aborted: ${runningIds.length} instance(s) returned to PENDING`,
    queueState: "STOPPED",
    runningCount: counts.running,
    pendingCount: counts.pending,
    runningIds,
  };
}

// ─── Discovery ───────────────────────────────────────────────────────────────

export function reloadTasks(
  db: DB,
  projectRoot: string,
  dataDir: string,
): { loaded: number; warnings: string[] } {
  const packageLocations = getPackageLocations(dataDir);
  const result = loadAllTasks(db, projectRoot, packageLocations);
  ensureQueuesForTasks(db);
  return result;
}

/**
 * Ask a live daemon to refresh its in-memory task/runner state. Returns false
 * when no daemon consumes the request within the timeout.
 */
export async function requestReload(db: DB): Promise<boolean> {
  const requestId = insertControlRequest(db, "reload", null, []);
  return waitForControlRequest(db, requestId);
}
