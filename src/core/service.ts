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
import { statSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  InstanceRow,
  InstanceState,
  QueueRow,
  QueueState,
  TaskRow,
} from "../db/schema.ts";
import { readLogFile, type LogRecord } from "../db/logs.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { CoreError } from "./errors.ts";
import { getPackageLocations } from "../tasks/lockfile.ts";
import { discoverAllTasks, loadAllTasks } from "../tasks/discovery.ts";
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
  total: number;
}

export interface TaskSummary {
  id: string;
  name: string;
  description: string;
  category: string | null;
  concurrency: number;
  timeout_ms: number;
  has_schema: boolean;
  schema: object | null;
}

export interface InstanceLog {
  instance: InstanceRow;
  records: LogRecord[];
}

export interface EnqueueResult {
  id: number;
  /** Optional caller-supplied id, null when the caller did not provide one. */
  user_id: string | null;
  createdAt: string;
  /** Normalized context after schema defaults and CLI path resolution. */
  input: unknown;
  /** Absolute working directory the instance will run in. */
  cwd: string;
}

export interface EnqueueOptions {
  /**
   * Absolute directory to run the instance in. Defaults to the core's
   * project root. Relative values are rejected; adapters resolve them.
   */
  cwd?: string;
  /**
   * Optional caller-supplied id. Stored as `user_id`; must be a non-empty
   * string and unique among existing instances.
   */
  userId?: string;
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

export interface DeleteInstanceOutcome {
  deleted: number;
  queueId: string;
}

export interface ReloadResult {
  loaded: number;
  warnings: string[];
}

export interface Core {
  enqueue(taskId: string, input: unknown, options?: EnqueueOptions): EnqueueResult;
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
  deleteInstance(instanceId: number): DeleteInstanceOutcome;

  reload(): ReloadResult;
  /** Discovery warnings without changing the registry; used by `status`. */
  discoveryWarnings(): string[];
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

// Abort processing includes a 5s cooperative grace period in the runner.
// Leave headroom so a successful abort is not reported as a timeout.
const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;

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

function summaryFromQueue(db: DB, queue: QueueRow): QueueSummary {
  const counts = getQueueCounts(db, queue.id);
  return {
    id: queue.id,
    state: queue.state,
    concurrency: queue.concurrency,
    running: counts.running,
    pending: counts.pending,
    succeeded: counts.succeeded,
    failed: counts.failed,
    total:
      counts.running + counts.pending + counts.succeeded + counts.failed,
  };
}

function queueSummary(db: DB, queueId: string): QueueSummary | null {
  const queue = getQueue(db, queueId);
  return queue ? summaryFromQueue(db, queue) : null;
}

function resolveWorkingDirectory(
  requested: string | undefined,
  projectRoot: string,
): string {
  if (requested === undefined) return resolve(projectRoot);

  if (!isAbsolute(requested)) {
    throw new CoreError(
      "INVALID_CWD",
      `Working directory must be absolute: ${requested}`,
    );
  }

  let stats;
  try {
    stats = statSync(requested);
  } catch {
    throw new CoreError(
      "INVALID_CWD",
      `Working directory does not exist: ${requested}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new CoreError(
      "INVALID_CWD",
      `Working directory is not a directory: ${requested}`,
    );
  }

  return resolve(requested);
}

function resolveUserId(userId: string | undefined): string | undefined {
  if (userId === undefined) return undefined;
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new CoreError(
      "INVALID_INSTANCE_ID",
      "Instance id must be a non-empty string",
    );
  }
  return userId;
}

/**
 * Tasks often carry their own identifier in the context (`input.id`). Use it
 * as the instance's user-facing id when the caller did not pass one
 * explicitly, so the dashboard and API can show it without a separate flag.
 */
function contextUserId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const id = (input as { id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

export function createCore(config: CoreConfig): Core {
  const { db, lifecycle, projectRoot, dataDir } = config;
  const controlTimeoutMs = config.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;

  return {
    enqueue(taskId, input, options = {}) {
      const task = getTask(db, taskId);
      if (!task) {
        throw new CoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
      }

      const cwd = resolveWorkingDirectory(options.cwd, projectRoot);

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

      const userId = resolveUserId(options.userId ?? contextUserId(value));

      const result = lifecycle.enqueue(taskId, value, { cwd, userId });
      return { ...result, input: value, cwd };
    },

    getTaskInputSchema(taskId) {
      const task = getTask(db, taskId);
      if (!task) {
        throw new CoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
      }
      return parseSchema(task.input_schema);
    },

    listQueues() {
      return getAllQueues(db).map((queue) => summaryFromQueue(db, queue));
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
        schema: parseSchema(task.input_schema),
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
      for (const logPath of result.logPaths) {
        try {
          unlinkSync(logPath);
        } catch {}
      }

      return { deleted: result.deleted, logPaths: result.logPaths };
    },

    deleteInstance(instanceId) {
      const result = lifecycle.deleteInstance(instanceId);

      // As with clear, the lifecycle does not touch the filesystem.
      if (result.logPath) {
        try {
          unlinkSync(result.logPath);
        } catch {}
      }

      return { deleted: 1, queueId: result.queueId };
    },

    reload() {
      const packageLocations = getPackageLocations(dataDir);
      const result = loadAllTasks(db, projectRoot, packageLocations);
      if (result.removed.length > 0) {
        lifecycle.retireQueues(result.removed);
      }
      lifecycle.syncQueues();
      return { loaded: result.loaded, warnings: result.warnings };
    },

    discoveryWarnings() {
      const packageLocations = getPackageLocations(dataDir);
      return discoverAllTasks(projectRoot, db, packageLocations).warnings;
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
