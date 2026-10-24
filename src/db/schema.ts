/**
 * SQLite schema for the task runner.
 *
 * Uses `bun:sqlite` for database operations.
 *
 * Tables:
 * - tasks: task definitions (discovered from search path)
 * - queues: queue state (one per task)
 * - instances: task instances (the runs)
 */

export const SCHEMA = `
-- Task definitions (discovered from search path)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,           -- namespace:id
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT,
  concurrency INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  input_schema TEXT,             -- JSON schema string or null
  manifest_hash TEXT,            -- hash of settings.json for change detection
  manifest_warnings TEXT,        -- JSON array of warning messages
  entry_point TEXT,              -- absolute path to index.ts entrypoint
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Queue state (one per task)
CREATE TABLE IF NOT EXISTS queues (
  id TEXT PRIMARY KEY,           -- = task id
  state TEXT NOT NULL DEFAULT 'IDLE',  -- IDLE, PROCESSING, STOPPED
  concurrency INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Task instances (the runs)
CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  input TEXT NOT NULL,           -- JSON input
  state TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING, RUNNING, SUCCESS, FAILED
  attempt INTEGER NOT NULL DEFAULT 1,
  exit_code INTEGER,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  ended_at TEXT,
  log_path TEXT,
  duration_ms INTEGER
);

-- Durable cross-process requests consumed by the daemon runner
CREATE TABLE IF NOT EXISTS control_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- abort, reload
  queue_id TEXT,
  instance_ids TEXT,             -- JSON array of instance ids (legacy)
  claim_tokens TEXT,             -- JSON array of {instanceId, attempt}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_instances_task_id ON instances(task_id);
CREATE INDEX IF NOT EXISTS idx_instances_state ON instances(state);
CREATE INDEX IF NOT EXISTS idx_instances_created_at ON instances(created_at);
CREATE INDEX IF NOT EXISTS idx_control_requests_pending ON control_requests(consumed_at, id);
`;

export type QueueState = 'IDLE' | 'PROCESSING' | 'STOPPED';
export type InstanceState = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface TaskRow {
  id: string;
  namespace: string;
  name: string;
  description: string;
  category: string | null;
  concurrency: number;
  timeout_ms: number;
  input_schema: string | null;
  manifest_hash: string | null;
  manifest_warnings: string | null;
  entry_point: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueueRow {
  id: string;
  state: QueueState;
  concurrency: number;
  created_at: string;
  updated_at: string;
}

export interface InstanceRow {
  id: number;
  task_id: string;
  input: string;
  state: InstanceState;
  attempt: number;
  exit_code: number | null;
  failure_reason: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  log_path: string | null;
  duration_ms: number | null;
}

export type ControlRequestKind = "abort" | "reload";

export interface ControlRequestRow {
  id: number;
  kind: ControlRequestKind;
  queue_id: string | null;
  instance_ids: string | null;
  claim_tokens: string | null;
  created_at: string;
  consumed_at: string | null;
}
