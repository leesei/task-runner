/**
 * Core task-runner operations.
 *
 * The core is transport-independent: the CLI calls these operations in-process
 * and the daemon's HTTP API wraps the same operations. It must not fetch,
 * print CLI output, or build HTTP responses.
 *
 * The lifecycle is private to core; adapters never import `db/queries` for
 * queue or instance state. The one documented exception is the runner's
 * control-request channel.
 */

import type { DB } from "../db/database.ts";
import {
  getAllQueues,
  getAllTasks,
  getControlRequest,
  getInstance,
  getInstancesByQueue,
  getQueue,
  getQueueCounts,
  getRunningInstances,
  getTask,
  insertControlRequest,
} from "../db/queries.ts";
import type { ControlToken } from "../db/queries.ts";
import type {
  InstanceRow,
  InstanceState,
  QueueState,
  TaskRow,
} from "../db/schema.ts";
import { readLogFile, type LogRecord } from "../db/logs.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { CoreError } from "./errors.ts";
import { getPackageLocations } from "../tasks/lockfile.ts";
import { loadAllTasks } from "../tasks/discovery.ts";
import {
  parseSchema,
  validateContext,
  type ValidationIssue,
} from "./validation.ts";

export { CoreError };
export type { ValidationIssue };

export interface QueueSummary {
  id: string;
  state: QueueState;
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

export interface EnqueueResult {
  id: number;
  createdAt: string;
}

export interface AbortOutcome {
  queueId: string;
  queueState: QueueState;
  /** Tokens that were RUNNING and are now PENDING at attempt + 1. */
  cancelled: ControlToken[];
}

export interface ClearOutcome {
  deleted: number;
  logPaths: string[];
}

export interface ReloadResult {
  loaded: number;
  warnings: string[];
}

export interface Core {
  enqueue(taskId: string, input: unknown): EnqueueResult;
  getTaskInputSchema(taskId: string): object | null;

  listQueues(): QueueSummary[];
  getQueue(queueId: string): QueueSummary | null;
  listTasks(): TaskSummary[];
  listTaskDefinitions(): TaskRow[];
  listInstances(queueId: string, state?: InstanceState): InstanceRow[];
  getInstance(instanceId: number): InstanceRow | null;
  readInstanceLog(instanceId: number): InstanceLog | null;

  start(queueId: string): QueueState;
  stop(queueId: string): QueueState;
  abort(queueId: string): Promise<AbortOutcome>;
  clear(queueId: string, all?: boolean): ClearOutcome;

  reload(): ReloadResult;
  syncQueues(): { created: number; updated: number };
  recoverOnBoot(): { reset: number; started: number; stayedStopped: number };
  requestReload(): Promise<boolean>;
}

export interface CoreConfig {
  db: DB;
  lifecycle: Lifecycle;
  projectRoot: string;
  dataDir: string;
  /** Bounded wait for the daemon to consume a control request. */
  controlTimeoutMs?: number;
}

const DEFAULT_CONTROL_TIMEOUT_MS = 5000;

function waitForControlRequest(
  db: DB,
  requestId: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
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

function queueSummary(db: DB, queueId: string): QueueSummary | null {
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

export function createCore(config: CoreConfig): Core {
  const { db, lifecycle, projectRoot, dataDir } = config;
  const controlTimeoutMs = config.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;

  return {
    enqueue(taskId, input) {
      const task = getTask(db, taskId);
      if (!task) {
        throw new CoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
      }

      // Validate before touching queue or instance state: a violation creates
      // no instance. CLI and HTTP share this path, so they cannot disagree.
      const { value, issues } = validateContext(task.input_schema, input);
      if (issues.length > 0) {
        throw new CoreError(
          "INPUT_SCHEMA_VIOLATION",
          `Context does not match the schema for ${taskId}`,
          { issues },
        );
      }

      return lifecycle.enqueue(taskId, value);
    },

    getTaskInputSchema(taskId) {
      const task = getTask(db, taskId);
      if (!task) {
        throw new CoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
      }
      return parseSchema(task.input_schema);
    },

    listQueues() {
      return getAllQueues(db).map((queue) => queueSummary(db, queue.id)!);
    },

    getQueue(queueId) {
      return queueSummary(db, queueId);
    },

    listTasks() {
      return getAllTasks(db).map((task) => ({
        id: task.id,
        name: task.name,
        description: task.description,
        category: task.category,
        concurrency: task.concurrency,
        timeout_ms: task.timeout_ms,
        has_schema: task.input_schema !== null,
      }));
    },

    listTaskDefinitions() {
      return getAllTasks(db);
    },

    listInstances(queueId, state) {
      const instances = getInstancesByQueue(db, queueId);
      return state ? instances.filter((instance) => instance.state === state) : instances;
    },

    getInstance(instanceId) {
      return getInstance(db, instanceId);
    },

    readInstanceLog(instanceId) {
      const instance = getInstance(db, instanceId);
      if (!instance) return null;
      const records = instance.log_path ? readLogFile(instance.log_path) : [];
      return { instance, records };
    },

    start(queueId) {
      return lifecycle.start(queueId);
    },

    stop(queueId) {
      return lifecycle.stop(queueId);
    },

    async abort(queueId) {
      const queue = getQueue(db, queueId);
      if (!queue) {
        throw new CoreError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`);
      }

      const tokens: ControlToken[] = getRunningInstances(db, queueId).map(
        (instance) => ({ instanceId: instance.id, attempt: instance.attempt }),
      );
      const requestId = insertControlRequest(db, "abort", queueId, tokens);

      if (!(await waitForControlRequest(db, requestId, controlTimeoutMs))) {
        throw new CoreError(
          "CONTROL_TIMEOUT",
          `Timed out waiting for the daemon to process the abort request for ${queueId}`,
        );
      }

      const after = getQueue(db, queueId);
      if (!after) {
        throw new CoreError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`);
      }

      // A token was cancelled only if the instance is now PENDING at the next
      // attempt. A stale request changes nothing, so this is empty.
      const cancelled = tokens.filter((token) => {
        const instance = getInstance(db, token.instanceId);
        return (
          instance !== null &&
          instance.state === "PENDING" &&
          instance.attempt === token.attempt + 1
        );
      });

      return { queueId, queueState: after.state, cancelled };
    },

    clear(queueId, all = false) {
      const result = lifecycle.clearQueue(queueId, { all });

      // The lifecycle owns state, not files. Core removes the logs it returned
      // best-effort; a missing file is not an error.
      const fs = require("node:fs");
      for (const logPath of result.logPaths) {
        try {
          fs.unlinkSync(logPath);
        } catch {}
      }

      return { deleted: result.deleted, logPaths: result.logPaths };
    },

    reload() {
      const packageLocations = getPackageLocations(dataDir);
      const result = loadAllTasks(db, projectRoot, packageLocations);
      lifecycle.syncQueues();
      return result;
    },

    syncQueues() {
      return lifecycle.syncQueues();
    },

    recoverOnBoot() {
      return lifecycle.recoverOnBoot();
    },

    async requestReload() {
      const requestId = insertControlRequest(db, "reload", null, []);
      return waitForControlRequest(db, requestId, controlTimeoutMs);
    },
  };
}
