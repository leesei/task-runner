# Design

How the daemon, database, lifecycle, and subcommands fit together. This
document describes the target design recorded in
[ADR-0001](adr/0001-task-lifecycle-ownership.md). `docs/SPECS.md` is the
behavioural specification; `GLOSSARY.md` defines the domain terms. Some parts
are not implemented yet — see [Known gaps](#known-gaps).

## Overview

`tq` is one Bun process for the daemon plus a CLI that can run offline against
the same SQLite database. Task definitions are discovered from a search path,
each definition gets one queue, and enqueued work becomes a task instance.

The design has four pieces:

- **core** — transport-independent operations. It owns database access, input
  validation, queue and instance rules, and typed errors.
- **task lifecycle** — the state machine behind core. It owns every write to
  queue and instance state and publishes state-change events after commit.
- **adapters** — the CLI and the HTTP API. They parse input, call core, map
  errors, and format output. Neither owns queue or instance rules.
- **runner** — the daemon loop. It claims runnable instances from the lifecycle,
  launches task modules, enforces timeouts, and consumes durable control
  requests.

```
             ┌────────────────┐
 CLI ───────▶│                │
             │      core      │──────▶ lifecycle ──▶ SQLite
 HTTP API ──▶│  (createCore)  │              │
             └────────────────┘              └──▶ EventSink ──▶ event bus ──▶ SSE
 runner ────▶ lifecycle
      └─────▶ execution ──▶ instance-<id>.jsonl
```

## Process model

- One daemon process owns the runner loop, the HTTP listener, and the task
  modules. Tasks execute in-process; there is no worker, child process, or
  container.
- The CLI is a separate process. It opens the same data directory, calls core
  in-process, and never calls the daemon over HTTP.
- Cross-process commands that need the live runner (`abort`, `reload`) use
  durable rows in `control_requests`. The runner consumes them on its poll tick.
- Daemon liveness is read from the descriptor pid, never from an HTTP health
  probe.

## Task definitions and discovery

A task is a folder with:

- `index.ts` — default-exports the task function;
- `README.md`;
- `settings.json` — namespace, id, name, description, concurrency, optional
  input schema, category, timeout;
- optionally a JSON Schema file referenced from the manifest.

The task id is `namespace:id`. Search order is project tasks, then user tasks,
then installed packages in lockfile order; the first match wins and conflicts
are reported as warnings.

Discovery and persistence are separate responsibilities:

- **discovery** scans the search path and returns task definitions and warnings.
  It does not write the database.
- **the task registry** reconciles definitions into the `tasks` table and calls
  the lifecycle's `syncQueues()` to ensure one queue per task and update
  concurrency.

Queue retirement for removed tasks is deferred (see [Known gaps](#known-gaps)).

## Data directory and persistence

The default data directory is `.task-runner/` in the project root. It holds:

- `taskrunner.db` — SQLite;
- `logs/` — one JSONL file per task instance;
- `daemon.json` — pid, port, data directory, start time.

SQLite stores task definitions, queues, instances, and control requests. Logs
stay out of SQLite so large output does not grow the database.

Instance ids are monotonically increasing integers and are the handle used by
the CLI, the API, and the dashboard.

### Tables

| Table              | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `tasks`            | Discovered definitions, including the entrypoint path and schema.    |
| `queues`           | One row per task id; state and concurrency.                          |
| `instances`        | Enqueued runs; state, attempt, input, timings, exit code, log path.  |
| `control_requests` | Durable `abort` and `reload` commands, consumed once by the runner.  |

## Core

`src/core/service.ts` exposes `createCore({ db, lifecycle })`. The lifecycle is
private to core; adapters call core operations only.

Core operations cover:

- **enqueue and reads** — enqueue, list queues, queue detail, list instances,
  instance detail, read log, list task definitions;
- **queue control** — start, stop, abort, clear;
- **maintenance** — reload discovery, sync queues, boot recovery;
- **install** — lockfile update and package task discovery (CLI-only adapter).

Core throws `CoreError` with a stable code. It does not parse CLI flags, print
output, build HTTP responses, or import the HTTP adapter.

## Task lifecycle

`src/core/lifecycle.ts` is the only writer of queue and instance state.

```ts
createLifecycle({ db, events, logDir }): Lifecycle

enqueue(taskId, input): { id, createdAt }
claimRunnable(queueId): Claim[]
finishRun(instanceId, outcome): { applied, state?, queueState? }
abortQueue(queueId): { instanceIds, queueState }
start(queueId): QueueState
stop(queueId): QueueState
syncQueues(): { created, updated }
recoverOnBoot(): { reset, started, stayedStopped }
```

`Claim` is `{ instanceId, taskId, entryPoint, timeoutMs, input, logPath }`.

### Instance state

```
PENDING ──claim──▶ RUNNING ──exit 0 / return──▶ SUCCESS
                       └──── non-zero / throw / timeout ──▶ FAILED
RUNNING ──abort──▶ PENDING            (attempt incremented, partial log kept)
```

### Queue state

```
IDLE ⇄ PROCESSING
PROCESSING ──stop / abort──▶ STOPPED
STOPPED ──start──▶ PROCESSING
PROCESSING ──last instance finishes──▶ IDLE
```

### Invariants

- A queue is `IDLE` when draining is allowed but there is nothing to do; a
  pending instance added to an `IDLE` queue moves it to `PROCESSING`.
- A queue is `STOPPED` when draining is not allowed; pending work waits.
- `claimRunnable` enforces FIFO order and concurrency inside one transaction.
- `finishRun` drains the queue in the same transaction when the last running
  instance finishes.
- Late completion after abort, timeout, or recovery returns `{ applied: false }`
  and changes nothing.
- `abortQueue` recomputes the currently running instances; it does not trust ids
  captured when the control request was written.
- `recoverOnBoot` increments the attempt of every instance it resets, so attempt
  counts every execution that started.
- A task definition always has exactly one queue, and the queue id equals the
  task id.

### Transactions and errors

Each intent-level operation uses one SQLite transaction. Events publish after
commit. Failures throw `CoreError` from `src/core/errors.ts` with one of:

`QUEUE_NOT_FOUND`, `INSTANCE_NOT_FOUND`, `INVALID_TRANSITION`,
`CLEAR_REFUSED_RUNNING`, `TASK_NOT_FOUND`, plus input and transport codes added
by other modules.

## Event seam

`src/core/events.ts` defines:

- the event types: `queueStateChanged` and `instanceStateChanged`;
- `EventSink` — `publish(event)`;
- `createEventBus()` — fan-out to subscribers, with subscriber exceptions
  isolated.

The daemon creates one bus and injects it into the lifecycle and the HTTP
adapter. The lifecycle publishes after commit, instance event before queue
event. The HTTP adapter subscribes and translates events to SSE. The lifecycle
never imports the adapter.

The bus is an in-process seam. Tests inject a recording sink; the daemon injects
the real bus. No adapter owns the listener registry.

## Runner

`createRunner({ db, lifecycle, events, pollIntervalMs })` runs one loop:

1. consume pending control requests;
2. for each `PROCESSING` queue, call `lifecycle.claimRunnable(queueId)`;
3. launch each claim with an `AbortController` and `executeTask`;
4. `executeTask` calls `lifecycle.finishRun` on completion, timeout, or throw;
5. queue draining happens inside `finishRun`.

The runner keeps the controller map, timeout timers, and task-module import. It
does not write queue or instance state directly. Control-request reads remain
the one direct `db/queries` use: they are a durable command channel, not task or
queue state.

## Execution and logs

The execution context is:

```ts
interface ExecutionContext<TInput> {
  input: TInput;
  signal: AbortSignal;
  done: (exitCode: number) => void;
}
```

- The default export is the execution contract. Calling `done(0)` succeeds;
  `done(nonZero)` or a throw fails; returning without `done` succeeds.
- Console interception is installed once at daemon start. Each execution runs in
  an `AsyncLocalStorage` scope tagged with the instance id, so concurrent
  instances write to the right log.
- Logs are append-only JSONL, one file per instance. The lifecycle computes
  `instance-<id>.jsonl` and persists `log_path` when it claims the instance.
  Execution appends; it never truncates, so a retry preserves the previous
  attempt.
- Cancellation is cooperative. The runner signals the instance's
  `AbortController`; a task that ignores the signal may keep running after its
  instance returns to `PENDING`. Late writes are fenced by the lifecycle's
  `applied: false` check.

## CLI

Every command:

1. resolves the project and data directory;
2. opens the database and constructs the lifecycle and core;
3. calls one core operation;
4. maps errors and prints output;
5. closes the database.

`src/cli/errors.ts` maps `CoreError.code` to an exit code: usage, unknown id, and
invalid input return 2; runtime failures return 1. Diagnostics from `-v` go to
stderr so stdout stays machine-readable.

The CLI never calls the daemon's HTTP API. Commands that need the live runner
check the descriptor pid and write a control request.

## HTTP API

`createApi({ core, events, dataDir, cwd })` is an adapter over core. Handlers:

1. parse and validate transport input;
2. call one core operation;
3. map `CoreError.code` to a status and JSON error body;
4. serialize the result.

SSE handlers subscribe to the event bus. Log streaming replays the instance log
and then follows it. The API carries no queue or instance rules of its own.

The dashboard is a read-only consumer of the same endpoints and events. It is
not implemented yet.

## Testing

The test surface follows the seams in `docs/SPECS.md`:

- **lifecycle seam (primary)** — call lifecycle operations against a temporary
  SQLite database with a recording `EventSink`. Cover FIFO, concurrency, stop,
  start, abort, drain, recovery, late completion, and events.
- **core seam** — core operations, discovery, enqueue, clear, reload, and error
  codes.
- **CLI seam** — subprocess tests for argument parsing, output, exit codes, and
  offline operation.
- **HTTP seam** — status codes, structured errors, SSE, and log streaming.

Tests must not assert on internal tables. A guard test fails if `src/runner/**`
or `src/core/**` imports `src/api/**`.

## Known gaps

- The lifecycle extraction, core factory, event bus, and runner claim loop are
  not implemented yet.
- Input validation and CLI context grammar (`@file`, `name=value`, `name:=value`,
  bare-string wrapping, path resolution) are pending.
- Reload does not retire queues for removed tasks.
- The dashboard is a placeholder.
- The CLI repeats project setup in every command until the project-handle
  refactor lands.
- The HTTP health handler reads `daemon.json` directly.

## References

- `docs/SPECS.md` — behavioural specification and implementation decisions.
- `docs/adr/0001-task-lifecycle-ownership.md` — why the lifecycle has one owner.
- `GLOSSARY.md` — task, task instance, queue, task lifecycle, claim, event sink.
- `tests/README.md` — fixtures and sample-task expectations.
