/**
 * Database query functions for tasks, queues, and instances.
 */

import type { DB } from "./database.ts";
import type { TaskRow, QueueRow, InstanceRow, QueueState, InstanceState } from "./schema.ts";

// ─── Tasks ─────────────────────────────────────────────────────────────────────

export function insertTask(db: DB, task: Omit<TaskRow, "created_at" | "updated_at">): void {
  db.run(
    `INSERT OR REPLACE INTO tasks
     (id, namespace, name, description, category, concurrency, timeout_ms, input_schema, manifest_hash, manifest_warnings, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      task.id,
      task.namespace,
      task.name,
      task.description,
      task.category ?? null,
      task.concurrency,
      task.timeout_ms,
      task.input_schema ?? null,
      task.manifest_hash ?? null,
      task.manifest_warnings ?? null,
    ],
  );
}

export function getTask(db: DB, id: string): TaskRow | null {
  const row = db.query<TaskRow>(
    "SELECT * FROM tasks WHERE id = ?",
  ).get(id);
  return row ?? null;
}

export function getAllTasks(db: DB): TaskRow[] {
  return db.query<TaskRow>("SELECT * FROM tasks ORDER BY namespace, id").all();
}

export function deleteTask(db: DB, id: string): void {
  db.run("DELETE FROM tasks WHERE id = ?", [id]);
}

export function getTasksWithWarnings(db: DB): TaskRow[] {
  return db.query<TaskRow>(
    "SELECT * FROM tasks WHERE manifest_warnings IS NOT NULL AND manifest_warnings != '' ORDER BY namespace, id",
  ).all();
}

// ─── Queues ────────────────────────────────────────────────────────────────────

export function ensureQueue(db: DB, queueId: string, concurrency: number): void {
  db.run(
    `INSERT OR IGNORE INTO queues (id, state, concurrency) VALUES (?, 'IDLE', ?)`,
    [queueId, concurrency],
  );
}

export function getQueue(db: DB, id: string): QueueRow | null {
  const row = db.query<QueueRow>("SELECT * FROM queues WHERE id = ?").get(id);
  return row ?? null;
}

export function getAllQueues(db: DB): QueueRow[] {
  return db.query<QueueRow>("SELECT * FROM queues ORDER BY id").all();
}

export function updateQueueState(db: DB, id: string, state: QueueState): void {
  db.run(
    "UPDATE queues SET state = ?, updated_at = datetime('now') WHERE id = ?",
    [state, id],
  );
}

export function updateQueueConcurrency(db: DB, id: string, concurrency: number): void {
  db.run(
    "UPDATE queues SET concurrency = ?, updated_at = datetime('now') WHERE id = ?",
    [concurrency, id],
  );
}

export function getQueuesByState(db: DB, state: QueueState): QueueRow[] {
  return db.query<QueueRow>(
    "SELECT * FROM queues WHERE state = ? ORDER BY id",
  ).all(state);
}

// ─── Instances ─────────────────────────────────────────────────────────────────

export function insertInstance(
  db: DB,
  taskId: string,
  input: string,
  logPath: string,
): number {
  const stmt = db.prepare(
    `INSERT INTO instances (task_id, input, log_path) VALUES (?, ?, ?)`,
  );
  stmt.run(taskId, input, logPath);
  return db.lastInsertRowId;
}

export function getInstance(db: DB, id: number): InstanceRow | null {
  const row = db.query<InstanceRow>(
    "SELECT * FROM instances WHERE id = ?",
  ).get(id);
  return row ?? null;
}

export function getAllInstances(db: DB): InstanceRow[] {
  return db.query<InstanceRow>(
    "SELECT * FROM instances ORDER BY id DESC",
  ).all();
}

export function getInstancesByQueue(db: DB, queueId: string): InstanceRow[] {
  return db.query<InstanceRow>(
    "SELECT * FROM instances WHERE task_id = ? ORDER BY id DESC",
  ).all(queueId);
}

export function getPendingInstances(db: DB, queueId: string): InstanceRow[] {
  return db.query<InstanceRow>(
    "SELECT * FROM instances WHERE task_id = ? AND state = 'PENDING' ORDER BY id ASC",
  ).all(queueId);
}

export function getRunningInstances(db: DB, queueId?: string): InstanceRow[] {
  const sql = queueId
    ? "SELECT * FROM instances WHERE state = 'RUNNING' AND task_id = ? ORDER BY id"
    : "SELECT * FROM instances WHERE state = 'RUNNING' ORDER BY id";
  return queueId
    ? db.query<InstanceRow>(sql).all(queueId)
    : db.query<InstanceRow>(sql).all();
}

export function updateInstanceState(
  db: DB,
  id: number,
  state: InstanceState,
  exitCode?: number,
  failureReason?: string,
): void {
  const now = new Date().toISOString();
  if (state === 'RUNNING') {
    db.run(
      "UPDATE instances SET state = ?, started_at = ? WHERE id = ?",
      [state, now, id],
    );
  } else {
    db.run(
      "UPDATE instances SET state = ?, ended_at = ?, exit_code = ?, failure_reason = ?, duration_ms = CASE WHEN started_at IS NOT NULL THEN CAST((julianday(datetime('now')) - julianday(started_at)) * 86400000 AS INTEGER) ELSE NULL END WHERE id = ?",
      [state, now, exitCode ?? null, failureReason ?? null, id],
    );
  }
}

export function resetRunningInstancesToPending(db: DB): number {
  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE instances SET state = 'PENDING', started_at = NULL, exit_code = NULL, failure_reason = NULL WHERE state = 'RUNNING'",
  );
  return result.changes;
}

export function deleteSuccessInstances(db: DB, queueId: string): number {
  // Get log paths before deleting
  const rows = db.query<{ log_path: string | null }>(
    "SELECT log_path FROM instances WHERE task_id = ? AND state = 'SUCCESS'",
  ).all(queueId);

  const result = db.run(
    "DELETE FROM instances WHERE task_id = ? AND state = 'SUCCESS'",
    [queueId],
  );

  // Delete log files
  const fs = require("node:fs");
  for (const row of rows) {
    if (row.log_path && fs.existsSync(row.log_path)) {
      try { fs.unlinkSync(row.log_path); } catch {}
    }
  }

  return result.changes;
}

export function deleteFinishedInstances(db: DB, queueId: string): { deleted: number; running_ids: number[] } {
  // Check for running instances first
  const running = db.query<{ id: number }>(
    "SELECT id FROM instances WHERE task_id = ? AND state = 'RUNNING'",
  ).all(queueId);

  if (running.length > 0) {
    return { deleted: 0, running_ids: running.map(r => r.id) };
  }

  // Get log paths for all finished instances
  const rows = db.query<{ log_path: string | null }>(
    "SELECT log_path FROM instances WHERE task_id = ? AND state IN ('SUCCESS', 'FAILED')",
  ).all(queueId);

  const result = db.run(
    "DELETE FROM instances WHERE task_id = ? AND state IN ('SUCCESS', 'FAILED')",
    [queueId],
  );

  // Delete log files
  const fs = require("node:fs");
  for (const row of rows) {
    if (row.log_path && fs.existsSync(row.log_path)) {
      try { fs.unlinkSync(row.log_path); } catch {}
    }
  }

  return { deleted: result.changes, running_ids: [] };
}

export function getQueueCounts(db: DB, queueId: string): {
  running: number;
  pending: number;
  succeeded: number;
  failed: number;
} {
  const running = db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM instances WHERE task_id = ? AND state = 'RUNNING'",
  ).get(queueId)!.count;
  const pending = db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM instances WHERE task_id = ? AND state = 'PENDING'",
  ).get(queueId)!.count;
  const succeeded = db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM instances WHERE task_id = ? AND state = 'SUCCESS'",
  ).get(queueId)!.count;
  const failed = db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM instances WHERE task_id = ? AND state = 'FAILED'",
  ).get(queueId)!.count;

  return { running, pending, succeeded, failed };
}

export function getTotalCounts(db: DB): {
  total: number;
  running: number;
  pending: number;
  succeeded: number;
  failed: number;
} {
  const running = db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM instances WHERE state = 'RUNNING'",
  ).get()!.count;
  const pending = db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM instances WHERE state = 'PENDING'",
  ).get()!.count;
  const succeeded = db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM instances WHERE state = 'SUCCESS'",
  ).get()!.count;
  const failed = db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM instances WHERE state = 'FAILED'",
  ).get()!.count;
  const total = running + pending + succeeded + failed;

  return { total, running, pending, succeeded, failed };
}
