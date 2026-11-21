/**
 * Task lifecycle: the only writer of queue and instance state.
 *
 * Every intent runs in one immediate SQLite transaction. Events are collected
 * during the transaction and published only after it commits, instance events
 * before queue events. The module touches no filesystem, imports no task code,
 * owns no AbortController, and enforces no timeout.
 *
 * See ADR-0001 (ownership) and ADR-0002 (completion fence).
 */

import { join, resolve } from "node:path";
import type { DB } from "../db/database.ts";
import type { InstanceState, QueueState } from "../db/schema.ts";
import { CoreError } from "./errors.ts";
import type { EventSink, LifecycleEvent } from "./events.ts";

export type { InstanceState, QueueState };

export interface ClaimToken {
  instanceId: number;
  attempt: number;
}

export interface Claim extends ClaimToken {
  taskId: string;
  entryPoint: string;
  timeoutMs: number;
  input: unknown;
  /** Absolute directory the instance was enqueued from. */
  cwd: string;
  logPath: string;
}

export type RunOutcome =
  | { kind: "success" }
  | { kind: "failure"; exitCode: number; reason?: string }
  | { kind: "timeout" };

export interface FinishResult {
  applied: boolean;
  ignored?: "not-running" | "stale-attempt";
  state?: InstanceState;
  queueState?: QueueState;
}

export interface AbortResult {
  /** Attempts that were RUNNING before the abort increment. */
  cancelled: ClaimToken[];
  queueState: QueueState;
  /** True when the request's tokens no longer match a RUNNING instance. */
  discarded?: boolean;
}

export interface ClearResult {
  deleted: number;
  logPaths: string[];
}

export interface DeleteInstanceResult {
  queueId: string;
  logPath: string | null;
}

export interface Lifecycle {
  enqueue(
    taskId: string,
    input: unknown,
    options?: { cwd?: string; userId?: string },
  ): { id: number; createdAt: string; user_id: string | null };
  claim(): Claim[];
  claimQueue(queueId: string): Claim[];
  finishRun(token: ClaimToken, outcome: RunOutcome): FinishResult;
  abortQueue(queueId: string, expected?: ClaimToken[]): AbortResult;
  start(queueId: string): QueueState;
  stop(queueId: string): QueueState;
  syncQueues(): { created: number; updated: number };
  /** Remove queues whose tasks disappeared from the registry. */
  retireQueues(queueIds: string[]): { retired: number };
  recoverOnBoot(): { reset: number; started: number; stayedStopped: number };
  clearQueue(queueId: string, options?: { all?: boolean }): ClearResult;
  /** Delete one instance in any state. Adapters signal RUNNING work separately. */
  deleteInstance(instanceId: number): DeleteInstanceResult;
}

export interface LifecycleConfig {
  db: DB;
  events: EventSink;
  logDir: string;
  /**
   * Working directory for instances whose row has no stored cwd (rows written
   * before the cwd column existed). New enqueues always store one.
   */
  defaultCwd?: string;
  now?: () => Date;
}

interface TaskRow {
  id: string;
  concurrency: number;
  timeout_ms: number;
  entry_point: string | null;
}

interface QueueRow {
  id: string;
  state: QueueState;
  concurrency: number;
}

interface InstanceRow {
  id: number;
  task_id: string;
  input: string;
  state: InstanceState;
  attempt: number;
  started_at: string | null;
  log_path: string | null;
}

interface ClaimedRow {
  id: number;
  task_id: string;
  input: string;
  cwd: string | null;
  attempt: number;
}

interface CollectResult {
  claims: Claim[];
  events: LifecycleEvent[];
}

/**
 * Run `fn` in one immediate transaction. `bun:sqlite`'s immediate mode takes
 * the write lock up front, so two processes cannot both read a free slot and
 * over-claim.
 */
function immediate<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate();
}

function parseInput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function durationMs(startedAt: string | null, endedAt: Date): number | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, endedAt.getTime() - started);
}

export function createLifecycle(config: LifecycleConfig): Lifecycle {
  const { db, events, logDir } = config;
  const defaultCwd = resolve(config.defaultCwd ?? process.cwd());
  const now = config.now ?? (() => new Date());

  function publish(collected: LifecycleEvent[]): void {
    for (const event of collected) {
      try {
        events.publish(event);
      } catch {
        // The lifecycle's contract isolates sink failures; a transition that
        // committed must not fail because a subscriber threw.
      }
    }
  }

  function getTask(taskId: string): TaskRow | null {
    return (
      db
        .query<TaskRow, [string]>(
          "SELECT id, concurrency, timeout_ms, entry_point FROM tasks WHERE id = ?",
        )
        .get(taskId) ?? null
    );
  }

  function getQueue(queueId: string): QueueRow | null {
    return (
      db
        .query<QueueRow, [string]>(
          "SELECT id, state, concurrency FROM queues WHERE id = ?",
        )
        .get(queueId) ?? null
    );
  }

  function queueCounts(queueId: string): { running: number; pending: number } {
    const row = db
      .query<{ running: number; pending: number }, [string, string, string]>(
        `SELECT
           SUM(CASE WHEN state = 'RUNNING' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN state = 'PENDING' THEN 1 ELSE 0 END) AS pending
         FROM instances WHERE task_id = ? AND state IN (?, ?)`,
      )
      .get(queueId, "RUNNING", "PENDING");
    return { running: row?.running ?? 0, pending: row?.pending ?? 0 };
  }

  function setQueueState(
    queue: QueueRow,
    state: QueueState,
    collected: LifecycleEvent[],
  ): QueueState {
    if (queue.state === state) return queue.state;
    db.run(
      "UPDATE queues SET state = ?, updated_at = ? WHERE id = ?",
      [state, now().toISOString(), queue.id],
    );
    collected.push({ type: "queueStateChanged", queueId: queue.id, state });
    return state;
  }

  function logPathFor(instanceId: number): string {
    return join(logDir, `instance-${instanceId}.jsonl`);
  }

  /**
   * Claim pending work from one queue. Caller owns the transaction.
   * `claim()` and `claimQueue()` share this helper; it is not a separate
   * scheduling policy.
   */
  function claimFromQueue(queueId: string, collected: LifecycleEvent[]): Claim[] {
    const queue = getQueue(queueId);
    if (!queue || queue.state !== "PROCESSING") return [];

    const counts = queueCounts(queueId);
    const free = queue.concurrency - counts.running;
    if (free <= 0) return [];

    const pending = db
      .query<ClaimedRow, [string, number]>(
        `SELECT id, task_id, input, cwd, attempt
         FROM instances
         WHERE task_id = ? AND state = 'PENDING'
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(queueId, free);

    const claims: Claim[] = [];
    for (const row of pending) {
      const task = getTask(row.task_id);
      if (!task) {
        throw new CoreError(
          "TASK_NOT_FOUND",
          `Task not found for pending instance ${row.id}: ${row.task_id}`,
        );
      }

      const startedAt = now().toISOString();
      const logPath = logPathFor(row.id);
      const result = db.run(
        `UPDATE instances
         SET state = 'RUNNING', started_at = ?, log_path = ?,
             exit_code = NULL, failure_reason = NULL,
             ended_at = NULL, duration_ms = NULL
         WHERE id = ? AND state = 'PENDING'`,
        [startedAt, logPath, row.id],
      );
      if (result.changes === 0) continue;

      claims.push({
        instanceId: row.id,
        attempt: row.attempt,
        taskId: row.task_id,
        entryPoint: task.entry_point ?? task.id,
        timeoutMs: task.timeout_ms,
        input: parseInput(row.input),
        cwd: row.cwd ?? defaultCwd,
        logPath,
      });
      collected.push({
        type: "instanceStateChanged",
        instanceId: row.id,
        state: "RUNNING",
      });
    }

    const after = queueCounts(queueId);
    if (after.running === 0 && after.pending === 0) {
      setQueueState(queue, "IDLE", collected);
    }

    return claims;
  }

  return {
    enqueue(taskId, input, options = {}) {
      const collected: LifecycleEvent[] = [];
      const result = immediate(db, () => {
        const task = getTask(taskId);
        if (!task) {
          throw new CoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
        }

        if (options.userId !== undefined) {
          const existing = db
            .query<{ id: number }, [string, string]>(
              `SELECT id FROM instances
               WHERE user_id = ?
                  OR (user_id IS NULL AND json_extract(input, '$.id') = ?)`,
            )
            .get(options.userId, options.userId);
          if (existing) {
            throw new CoreError(
              "INSTANCE_ID_CONFLICT",
              `Instance id already exists: ${options.userId}`,
            );
          }
        }

        db.run(
          "INSERT OR IGNORE INTO queues (id, state, concurrency) VALUES (?, 'IDLE', ?)",
          [taskId, task.concurrency],
        );

        const createdAt = now().toISOString();
        const inserted = db.run(
          `INSERT INTO instances (task_id, input, cwd, user_id, state, attempt, created_at)
           VALUES (?, ?, ?, ?, 'PENDING', 1, ?)`,
          [
            taskId,
            JSON.stringify(input),
            options.cwd ?? defaultCwd,
            options.userId ?? null,
            createdAt,
          ],
        );
        const id = Number(
          (inserted as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0,
        );

        collected.push({
          type: "instanceStateChanged",
          instanceId: id,
          state: "PENDING",
        });

        const queue = getQueue(taskId);
        if (queue?.state === "IDLE") {
          setQueueState(queue, "PROCESSING", collected);
        }

        return { id, createdAt, user_id: options.userId ?? null };
      });

      publish(collected);
      return result;
    },

    claim() {
      const collected: LifecycleEvent[] = [];
      const claims = immediate(db, () => {
        const queues = db
          .query<QueueRow, []>(
            "SELECT id, state, concurrency FROM queues WHERE state = 'PROCESSING' ORDER BY id",
          )
          .all();

        const all: Claim[] = [];
        const queueEvents: LifecycleEvent[] = [];
        for (const queue of queues) {
          const local: LifecycleEvent[] = [];
          all.push(...claimFromQueue(queue.id, local));
          for (const event of local) {
            if (event.type === "instanceStateChanged") {
              collected.push(event);
            } else if (event.type === "queueStateChanged") {
              queueEvents.push(event);
            }
          }
        }

        // Instance events first (ascending instance id), then queue events
        // (ascending queue id).
        collected.sort((a, b) =>
          a.type === "instanceStateChanged" && b.type === "instanceStateChanged"
            ? a.instanceId - b.instanceId
            : 0,
        );
        queueEvents.sort((a, b) =>
          a.type === "queueStateChanged" && b.type === "queueStateChanged"
            ? a.queueId.localeCompare(b.queueId)
            : 0,
        );
        collected.push(...queueEvents);
        return all;
      });

      publish(collected);
      return claims;
    },

    claimQueue(queueId) {
      const collected: LifecycleEvent[] = [];
      const claims = immediate(db, () => {
        const queue = getQueue(queueId);
        if (!queue) {
          throw new CoreError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`);
        }
        return claimFromQueue(queueId, collected);
      });

      publish(collected);
      return claims;
    },

    finishRun(token, outcome) {
      const collected: LifecycleEvent[] = [];
      const result = immediate(db, (): FinishResult => {
        const instance = db
          .query<InstanceRow, [number]>(
            "SELECT id, task_id, input, state, attempt, started_at, log_path FROM instances WHERE id = ?",
          )
          .get(token.instanceId);

        if (!instance || instance.state !== "RUNNING") {
          return { applied: false, ignored: "not-running" };
        }
        if (instance.attempt !== token.attempt) {
          return { applied: false, ignored: "stale-attempt" };
        }

        const endedAt = now();
        const state: InstanceState = outcome.kind === "success" ? "SUCCESS" : "FAILED";
        const exitCode =
          outcome.kind === "success"
            ? 0
            : outcome.kind === "failure"
              ? outcome.exitCode
              : null;
        const reason =
          outcome.kind === "failure"
            ? outcome.reason ?? null
            : outcome.kind === "timeout"
              ? "timeout"
              : null;

        const updated = db.run(
          `UPDATE instances
           SET state = ?, ended_at = ?, exit_code = ?, failure_reason = ?, duration_ms = ?
           WHERE id = ? AND state = 'RUNNING' AND attempt = ?`,
          [
            state,
            endedAt.toISOString(),
            exitCode,
            reason,
            durationMs(instance.started_at, endedAt),
            instance.id,
            instance.attempt,
          ],
        );
        if (updated.changes === 0) {
          return { applied: false, ignored: "stale-attempt" };
        }

        collected.push({
          type: "instanceStateChanged",
          instanceId: instance.id,
          state,
        });

        let queueState: QueueState | undefined;
        const queue = getQueue(instance.task_id);
        if (queue && queue.state === "PROCESSING") {
          const counts = queueCounts(queue.id);
          if (counts.running === 0 && counts.pending === 0) {
            queueState = setQueueState(queue, "IDLE", collected);
          } else {
            queueState = queue.state;
          }
        } else if (queue) {
          queueState = queue.state;
        }

        return { applied: true, state, queueState };
      });

      publish(collected);
      return result;
    },

    abortQueue(queueId, expected) {
      const collected: LifecycleEvent[] = [];
      const result = immediate(db, (): AbortResult => {
        const queue = getQueue(queueId);
        if (!queue) {
          throw new CoreError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`);
        }

        const running = db
          .query<InstanceRow, [string]>(
            `SELECT id, task_id, input, state, attempt, started_at, log_path
             FROM instances WHERE task_id = ? AND state = 'RUNNING' ORDER BY id`,
          )
          .all(queueId);

        if (expected) {
          const matches = running.some((instance) =>
            expected.some(
              (token) =>
                token.instanceId === instance.id &&
                token.attempt === instance.attempt,
            ),
          );
          if (!matches) {
            return { cancelled: [], queueState: queue.state, discarded: true };
          }
        }

        const cancelled: ClaimToken[] = [];
        for (const instance of running) {
          db.run(
            `UPDATE instances
             SET state = 'PENDING', attempt = attempt + 1,
                 started_at = NULL, ended_at = NULL,
                 exit_code = NULL, failure_reason = NULL, duration_ms = NULL
             WHERE id = ? AND state = 'RUNNING' AND attempt = ?`,
            [instance.id, instance.attempt],
          );
          cancelled.push({ instanceId: instance.id, attempt: instance.attempt });
          collected.push({
            type: "instanceStateChanged",
            instanceId: instance.id,
            state: "PENDING",
          });
        }

        const queueState = setQueueState(queue, "STOPPED", collected);
        return { cancelled, queueState };
      });

      publish(collected);
      return result;
    },

    start(queueId) {
      const collected: LifecycleEvent[] = [];
      const state = immediate(db, () => {
        const queue = getQueue(queueId);
        if (!queue) {
          throw new CoreError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`);
        }
        const counts = queueCounts(queueId);
        const target: QueueState =
          counts.running > 0 || counts.pending > 0 ? "PROCESSING" : "IDLE";
        return setQueueState(queue, target, collected);
      });

      publish(collected);
      return state;
    },

    stop(queueId) {
      const collected: LifecycleEvent[] = [];
      const state = immediate(db, () => {
        const queue = getQueue(queueId);
        if (!queue) {
          throw new CoreError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`);
        }
        return setQueueState(queue, "STOPPED", collected);
      });

      publish(collected);
      return state;
    },

    syncQueues() {
      const collected: LifecycleEvent[] = [];
      const result = immediate(db, () => {
        const tasks = db
          .query<TaskRow, []>(
            "SELECT id, concurrency, timeout_ms, entry_point FROM tasks ORDER BY id",
          )
          .all();

        let created = 0;
        let updated = 0;

        for (const task of tasks) {
          if (!Number.isInteger(task.concurrency) || task.concurrency <= 0) {
            throw new CoreError(
              "INVALID_CONCURRENCY",
              `Task ${task.id} has invalid concurrency: ${task.concurrency}`,
            );
          }

          const queue = getQueue(task.id);
          if (!queue) {
            db.run(
              "INSERT INTO queues (id, state, concurrency) VALUES (?, 'IDLE', ?)",
              [task.id, task.concurrency],
            );
            created++;
            collected.push({
              type: "queueStateChanged",
              queueId: task.id,
              state: "IDLE",
            });
            continue;
          }

          if (queue.concurrency !== task.concurrency) {
            db.run(
              "UPDATE queues SET concurrency = ?, updated_at = ? WHERE id = ?",
              [task.concurrency, now().toISOString(), task.id],
            );
            updated++;
          }
        }

        return { created, updated };
      });

      publish(collected);
      return result;
    },

    retireQueues(queueIds) {
      if (queueIds.length === 0) return { retired: 0 };

      return immediate(db, () => {
        let retired = 0;
        for (const queueId of queueIds) {
          const result = db.run("DELETE FROM queues WHERE id = ?", [queueId]);
          retired += result.changes;
        }
        return { retired };
      });
    },

    recoverOnBoot() {
      const collected: LifecycleEvent[] = [];
      const result = immediate(db, () => {
        const running = db
          .query<{ id: number }, []>(
            "SELECT id FROM instances WHERE state = 'RUNNING' ORDER BY id",
          )
          .all();

        for (const instance of running) {
          db.run(
            `UPDATE instances
             SET state = 'PENDING', attempt = attempt + 1,
                 started_at = NULL, ended_at = NULL,
                 exit_code = NULL, failure_reason = NULL, duration_ms = NULL
             WHERE id = ? AND state = 'RUNNING'`,
            [instance.id],
          );
          collected.push({
            type: "instanceStateChanged",
            instanceId: instance.id,
            state: "PENDING",
          });
        }

        const queues = db
          .query<QueueRow, []>(
            "SELECT id, state, concurrency FROM queues ORDER BY id",
          )
          .all();

        let started = 0;
        let stayedStopped = 0;
        for (const queue of queues) {
          if (queue.state === "STOPPED") {
            stayedStopped++;
            continue;
          }
          started++;
          if (queue.state !== "PROCESSING") {
            setQueueState(queue, "PROCESSING", collected);
          }
        }

        return { reset: running.length, started, stayedStopped };
      });

      publish(collected);
      return result;
    },

    deleteInstance(instanceId) {
      const collected: LifecycleEvent[] = [];
      const result = immediate(db, (): DeleteInstanceResult => {
        const instance = db
          .query<InstanceRow, [number]>(
            "SELECT id, task_id, input, state, attempt, started_at, log_path FROM instances WHERE id = ?",
          )
          .get(instanceId);

        if (!instance) {
          throw new CoreError(
            "INSTANCE_NOT_FOUND",
            `Instance not found: ${instanceId}`,
          );
        }

        const queue = getQueue(instance.task_id);
        db.run("DELETE FROM instances WHERE id = ?", [instanceId]);
        collected.push({
          type: "instancesCleared",
          queueId: instance.task_id,
          instanceIds: [instanceId],
        });

        // Deleting the last PENDING or RUNNING instance can leave an empty
        // queue marked PROCESSING; no finish will arrive to drain it.
        if (queue?.state === "PROCESSING") {
          const counts = queueCounts(instance.task_id);
          if (counts.running === 0 && counts.pending === 0) {
            setQueueState(queue, "IDLE", collected);
          }
        }

        return { queueId: instance.task_id, logPath: instance.log_path };
      });

      publish(collected);
      return result;
    },

    clearQueue(queueId, options = {}) {
      const collected: LifecycleEvent[] = [];
      const result = immediate(db, (): ClearResult => {
        const queue = getQueue(queueId);
        if (!queue) {
          throw new CoreError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`);
        }

        const all = options.all === true;
        if (all) {
          const running = db
            .query<{ id: number }, [string]>(
              "SELECT id FROM instances WHERE task_id = ? AND state = 'RUNNING' ORDER BY id",
            )
            .all(queueId);
          if (running.length > 0) {
            throw new CoreError(
              "CLEAR_REFUSED_RUNNING",
              `Cannot clear --all: ${running.length} instance(s) are RUNNING`,
              { runningIds: running.map((row) => row.id) },
            );
          }
        }

        const eligible = all
          ? db
              .query<{ id: number; log_path: string | null }, [string]>(
                `SELECT id, log_path FROM instances
                 WHERE task_id = ? AND state IN ('SUCCESS', 'FAILED') ORDER BY id`,
              )
              .all(queueId)
          : db
              .query<{ id: number; log_path: string | null }, [string]>(
                `SELECT id, log_path FROM instances
                 WHERE task_id = ? AND state = 'SUCCESS' ORDER BY id`,
              )
              .all(queueId);

        if (eligible.length === 0) {
          return { deleted: 0, logPaths: [] };
        }

        const ids = eligible.map((row) => row.id);
        const placeholders = ids.map(() => "?").join(", ");
        db.run(`DELETE FROM instances WHERE id IN (${placeholders})`, ids);

        collected.push({
          type: "instancesCleared",
          queueId,
          instanceIds: ids,
        });

        return {
          deleted: ids.length,
          logPaths: eligible
            .map((row) => row.log_path)
            .filter((path): path is string => path !== null),
        };
      });

      publish(collected);
      return result;
    },
  };
}
