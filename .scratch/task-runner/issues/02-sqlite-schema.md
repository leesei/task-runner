# 02: SQLite schema for tasks, queues, and instances

**What to build:** A SQLite schema (via `bun:sqlite`) that stores task definitions, queues, and task instances, plus the bootstrap that creates the tables on first run. Instance ids are monotonically increasing integers. Queues carry control state (IDLE / PROCESSING / STOPPED) and concurrency. Instances carry task id, normalized input, state, attempt number, exit code, failure reason, created-at, started-at, ended-at, and log file path. The database schema supports the full lifecycle: enqueue, state transitions, clear, and crash recovery.

**Blocked by:** 01

**Status:** resolved

- [ ] Database schema has tables: `tasks` (id, namespace, name, description, category, concurrency, timeout_ms, input_schema, manifest_hash), `queues` (id, state, concurrency, created_at), `instances` (id, task_id, input, state, attempt, exit_code, failure_reason, created_at, started_at, ended_at, log_path)
- [ ] Instance ids are monotonically increasing integers (auto-increment or explicit sequence)
- [ ] Bootstrap creates tables if they don't exist on first open
- [ ] The data directory is created if it doesn't exist
- [ ] A log directory exists inside the data directory for JSONL log files
- [ ] Schema is defined in a single source-of-truth module used by both daemon and offline CLI
