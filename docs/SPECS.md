# Task Runner — Specification

Status: ready-for-agent
Feature: task-runner

## Problem Statement

I run the same CLI commands over and over against different inputs — listing directories,
hashing files, inspecting media, dumping environment variables — and I do it either by hand
or with one-off shell loops. That workflow has no memory and no visibility:

- I cannot see which runs succeeded, which failed, how long they took, or what they printed
  once the terminal scrolls or the shell session ends. Stdout and stderr are gone.
- I cannot cap how many copies of an expensive command run at once, so a loop either crawls
  or saturates the machine.
- I cannot pause a batch when something looks wrong, resume it later, or cancel one run and
  retry it without losing the rest of the queue.
- Everything I enqueued is lost if the process dies or I restart it.
- Writing a reusable job means writing another ad-hoc script: there is no shared input
  contract, no way to validate input before running, no README convention, no way to ship
  several related jobs together, and no place for two jobs to share helper code.
- Each job is a discovery problem of its own: I have to remember where the script lives and
  how to invoke it.

The existing sample jobs in this repo (`ls`, `minfo`, plus the newer `cat`, `env`, `sha256`)
already show the shape of the work, but they are plain async functions with their own
individual conventions, no uniform lifecycle, and no runner around them.

## Solution

A single Bun-based service, `tq`, that turns "run this job with this input" into a queued,
observable task:

- A long-lived **daemon** discovers task definitions from a search path (project, user, and
  installed packages), gives each task definition its own **queue**, and runs **task
  instances** in enqueue order with a per-queue concurrency limit.
- A **CLI** enqueues work and controls queues: add, start, stop, abort, clear, status, logs,
  install, reload. It calls the core service directly and never uses the daemon's HTTP API, so
  it works whether or not the daemon is running.
- A **core** service owns all behavior and state access. The CLI and the daemon's HTTP API are
  adapters over the same core functions, so the two surfaces cannot drift apart.
- A **web dashboard** served by the daemon shows every queue, its state, its running and
  pending counts, its recent instances, and each instance's captured output — updating live.
- Every instance has a lifecycle of PENDING → RUNNING → SUCCESS/FAILED, an exit code, timings,
  validated input, and captured stdout/stderr.
- State survives restarts in SQLite; logs survive as files on disk. Work enqueued while the
  daemon was down is picked up when it starts, and work interrupted by a crash is retried.
- Tasks are self-describing folders: entrypoint, README, settings, and an optional input
  schema. Several tasks can ship in one package and share helper modules, and a task's input
  is validated against its declared schema before it is enqueued.
- Task ids are namespaced (`namespace:id`), so two packages can both provide a `convert`.
- The sample tasks in this repo become real tasks under this contract: `ls`, `cat`, `env`,
  `sha256`, and `minfo`, with `cat` and `env` redacting sensitive-looking values.

## User Stories

1. As a developer with a batch of CLI work, I want to enqueue one job per input, so that I don't hand-run the same command repeatedly.
2. As a developer, I want to enqueue tasks while the daemon is running, so that I can keep adding work as I discover it.
3. As a developer, I want to enqueue tasks before starting the daemon, so that I can prepare a batch first.
4. As a developer, I want each enqueued item to become a task instance with a stable id, so that I can refer to it later.
5. As a developer, I want to see the input an instance was enqueued with, so that I can tell two similar runs apart.
6. As a developer, I want the daemon to start processing registered queues automatically, so that I don't have to start each one by hand.
7. As a developer, I want work within a queue processed in enqueue order, so that results appear predictably.
8. As a developer, I want to configure how many instances of a task may run at once, so that expensive tasks don't overload my machine.
9. As a developer, I want concurrency configured per task, so that a fast listing task can run many at once while media analysis runs one at a time.
10. As a developer, I want an instance that exits zero to become SUCCESS and one that exits non-zero or throws to become FAILED, so that I can trust the dashboard without reading every log.
11. As a developer, I want to see the exit code of each instance, so that I can distinguish different failure modes.
12. As a developer, I want start time, end time, and duration recorded for every instance, so that I can spot slow runs.
13. As a developer, I want stdout and stderr of every instance captured, so that output is not lost when a terminal scrolls.
14. As a developer, I want to read the captured output of a finished instance, so that I can diagnose a failure after the fact.
15. As a developer, I want to follow the output of a running instance live, so that I can watch progress.
16. As a developer, I want stdout and stderr interleaved in the order they were produced, so that I can follow the sequence of events.
17. As a developer, I want partial output preserved when I abort an instance, so that I can see how far it got.
18. As a developer, I want to stop a queue, so that no new work starts while current runs finish.
19. As a developer, I want to start a stopped queue, so that its pending work resumes.
20. As a developer, I want abort to cancel the running instance and return it to PENDING, so that I can retry after fixing the cause.
21. As a developer, I want abort to leave the queue stopped, so that a retry does not immediately restart before I ask.
22. As a developer, I want to see whether a queue is IDLE, PROCESSING, or STOPPED, so that I know whether work is moving.
23. As a developer, I want to see how many instances are pending and running per queue, so that I can judge progress.
24. As a developer, I want new work added to a STOPPED queue to wait, so that a deliberate stop is not silently undone.
25. As a developer, I want new work added to an IDLE queue to start promptly, so that I don't need an extra start command.
26. As a developer, I want to clear successful instances from a queue, so that the queue view stays readable.
27. As a developer, I want to clear all finished instances from a queue, so that I can reset after a batch.
28. As a developer, I want clearing to refuse to delete running instances, so that I cannot lose in-flight work.
29. As a developer, I want clearing to delete the associated log files, so that disk usage does not grow forever.
30. As a developer, I want a hung task to time out, so that one bad instance eventually frees its slot instead of blocking the queue forever.
31. As a developer, I want the daemon to survive an unhandled task error, so that one bad task does not take down every queue.
32. As a task author, I want to add a task by dropping a folder into a search path, so that I can extend the system without changing the runner.
33. As a task author, I want my task folder to be self-describing with a README, settings, and an optional input schema, so that others can use it without reading its code.
34. As a task author, I want the entrypoint to be a single default export that receives a context, so that there is one obvious contract to implement.
35. As a task author, I want the context to carry validated input, an abort signal, and a completion callback, so that I can implement my behavior without knowing runner internals.
36. As a task author, I want to print with `console.log` and `console.error` and have it captured, so that I don't have to learn a logging API.
37. As a task author, I want to declare my input with JSON Schema, so that users get validation and usage hints.
38. As a task author, I want a schema-less task to accept arbitrary input, so that trivial tasks need no extra ceremony.
39. As a task author, I want to declare a display name, description, category, and timeout in settings, so that the CLI and dashboard can present my task sensibly.
40. As a user, I want a bare argument auto-wrapped when a task has exactly one required string input, so that `tq add default:ls fixture/1` works without writing JSON.
41. As a user, I want to pass structured input as JSON, so that tasks with several fields are usable from the CLI.
42. As a user, I want invalid input rejected at enqueue time with a clear message, so that I don't discover the mistake only after the task runs.
43. As a user, I want task ids namespaced, so that two packages can both ship a task named `convert`.
44. As a user, I want my project and user task folders to use a `default` namespace, so that common tasks have short ids.
45. As a user, I want project tasks to win over user tasks with the same id, so that a project can pin its own version.
46. As a user, I want a warning when two tasks claim the same id, so that shadowing is visible instead of silent.
47. As a package author, I want one package to ship several tasks, so that a toolkit installs as a unit.
48. As a package author, I want tasks in a package to import shared modules, so that common helpers are not duplicated or copied per task.
49. As a user, I want to install a task package, so that I can use tasks someone else wrote.
50. As a user, I want installed package tasks registered under their declared namespace, so that ids stay stable across machines.
51. As a user, I want to reload task definitions without restarting the daemon, so that I can iterate on a task.
52. As a user, I want a concurrency change to take effect for new launches after reload, so that I can tune load without downtime.
53. As a user, I want a web dashboard, so that I can see the whole system at a glance without terminal commands.
54. As a user, I want the dashboard to list every queue with its state and counts, so that I can see what is moving and what is stopped.
55. As a user, I want the dashboard to list instances with their states, exit codes, and durations, so that I can find failures quickly.
56. As a user, I want the dashboard to update live, so that I don't have to refresh.
57. As a user, I want to open an instance and read or tail its log in the browser, so that I can diagnose a run without the CLI.
58. As a user, I want the dashboard to work when I open it mid-run, so that current state arrives without a reload.
59. As a user, I want queue and instance data to survive a daemon restart, so that a crash does not lose my queue.
60. As a user, I want instances interrupted by a crash returned to PENDING, so that they are retried instead of being stuck RUNNING.
61. As a user, I want queues that were stopped to stay stopped after a restart, so that deliberate stops are respected.
62. As a user, I want the CLI to work when the daemon is not running, so that I can enqueue and inspect offline.
63. As a user, I want the CLI to print the new instance id after enqueue, so that I can find the run later.
64. As a user, I want CLI commands to exit non-zero on failure, so that I can script them.
65. As a user, I want a status command that lists queues, so that I don't need the browser for a quick check.
66. As a user, I want a logs command for one instance, so that I can read its output in my terminal.
67. As a user, I want clear errors for unknown task ids, malformed JSON, and schema violations, so that mistakes are easy to fix.
68. As a user, I want `cat` and `env` to redact sensitive-looking values, so that secrets don't land in logs or on the dashboard.
69. As a user, I want redaction to remain the task's decision, so that the runner does not corrupt output from tasks that need exact bytes.
70. As a user, I want a task that needs an external tool to fail with a clear message when that tool is missing, so that I know what to install.
71. As a developer, I want the sample tasks (`ls`, `cat`, `env`, `sha256`, `minfo`) to run through the runner contract, so that the repo demonstrates the system end to end.
72. As a maintainer, I want the CLI and HTTP API to call the same core functions, so that both surfaces behave identically and the CLI never depends on the daemon's HTTP port.
73. As a developer, I want queue control to reach a running daemon without HTTP, so that CLI control works even when the API is unavailable.
74. As a task author, I want the context schema to define the accepted input, so that users know exactly what a task accepts.
75. As a user, I want `tq add` to reject context that does not match the task schema, so that bad work never enters the queue.
76. As a user, I want `POST /api/instances` to reject context that does not match the task schema, so that API clients get the same protection as CLI users.
77. As a user, I want to pass escaped JSON directly, so that structured contexts are easy to write in a shell.
78. As a user, I want to pass `@file` to read JSON from a file, so that large or reusable contexts do not have to be typed inline.
79. As a user, I want `name=value` assignments for string fields, so that common contexts are short and readable.
80. As a user, I want `name:=value` assignments for non-string fields, so that numbers, booleans, null, arrays, and objects can be set without writing a full JSON object.
81. As a user, I want relative file paths in a context resolved against my invocation directory, so that `tq add default:cat fixture/1` works from the directory where I ran it.
82. As a user, I want absolute file paths left unchanged, so that explicitly addressed files are never rewritten.
83. As a user, I want `tq add` to print the instance time, task, and context, so that I can confirm exactly what was queued.
84. As a user, I want a `-v` verbosity option, so that I can see how the CLI resolved the task, context, and data directory when something is unclear.
85. As a user, I want validation errors to identify the failing field, so that I can fix the context without guessing.
86. As a maintainer, I want context validation to live in the core, so that CLI and HTTP cannot disagree about what a task accepts.

## Implementation Decisions

### D1 — Process model

- One daemon process owns every queue and runs task instances as concurrent async
  executions **in the same process**, launched by the runner.
- Tasks are trusted code installed by the user. There is no child-process sandbox, worker
  thread, or container in v1.
- Bun built-ins are used wherever possible: `bun:sqlite`, `Bun.serve`, Bun's shell (`$`),
  `AbortController`, and the built-in test runner.
- The core is transport-independent (D10). The CLI and the HTTP server are adapters around it;
  neither owns queue or instance rules of its own.

### D2 — Task identity, discovery, and precedence

- A task id is `namespace:id` from the start; `:` is the separator.
- A task definition is one folder containing:
  - an entrypoint module (`index.ts`) that default-exports the task function;
  - `README.md`;
  - `settings.json` (the manifest);
  - optionally an input schema file referenced from settings;
  - optionally per-runtime descriptors for presentation hints.
- Identity is **declared in the manifest**, not inferred from the folder name. If `namespace`
  is omitted it defaults to `default`; `id` is required.
- Search paths, highest precedence first:
  1. the project task folder (a `tasks` directory in the working directory);
  2. the user task folder (under the user's `tq` home);
  3. task locations recorded by installed packages, in lockfile order.
- First match wins; a conflicting later definition is skipped and reported as a warning at
  load and at reload. Shadows are never merged.
- A **task package** is a Bun package whose own `tasks/` directory holds one folder per task,
  with shared modules at the package root or in a `lib/` directory. Tasks import shared code
  by relative paths; the runner imports each entrypoint by its resolved location, so normal
  module resolution applies.

### D3 — Task folder contract

- The manifest fields are: `namespace`, `id`, `name`, `description`, `concurrency`,
  `inputSchema` (optional file name), `category` (optional), `timeoutMs` (optional),
  `agents` (optional presentation descriptors), and `env` (reserved; ignored in v1).
- `concurrency` is the maximum number of RUNNING instances for that queue; it defaults to 1.
- `timeoutMs` defaults to 30 minutes. A timed-out instance ends FAILED with reason `timeout`
  and does not return to PENDING.
- The entrypoint's default export is the only required execution contract. The existing
  named `runWith` export in the sample tasks may remain as the implementation behind
  `default`, but it is not part of the runner's contract.
- A task with a malformed manifest, a missing entrypoint, or an unreadable schema is skipped
  with a warning rather than failing the daemon; `status` and `reload` surface the warning so
  the author can see why the task did not register.
- Reload re-reads manifests and schemas, adds queues for new tasks, and retires queues for
  removed tasks. The daemon then re-imports entrypoints with a cache-busting version so edited
  task code is picked up without a restart. Discovery and database updates are core
  operations; module re-import is applied when the daemon consumes a reload request (D10).
  Concurrency changes apply to new launches; RUNNING instances are unaffected.

### D4 — Input contract

- The context is a JSON value whose accepted shape is defined by the task's input schema.
- Schema validation is a core operation performed at enqueue time, so the CLI and HTTP API
  accept and reject the same contexts with the same errors. It supports the JSON Schema
  subset used by task authors: `type`, `properties`, `required`, `enum`, `minimum`,
  `maximum`, `default`, `description`, and `format`. Unknown keywords are ignored.
- A schema violation creates no instance. The core returns `INPUT_SCHEMA_VIOLATION` with a
  list of `{ path, message }` issues. The CLI prints each issue and exits 2; HTTP returns
  status 400 with the same code and issues.
- When no schema is present, the context is accepted as-is, so a minimal task can take a
  string or arbitrary object without validation.
- A string property with `"format": "path"` is a filesystem path. The CLI resolves those
  values before validation: relative values are resolved against the invocation directory and
  stored as absolute paths; absolute values are left unchanged. Path arrays (a property whose
  type is an array of strings with `format: "path"`) are resolved the same way. The HTTP API
  does not resolve paths; clients send absolute paths when the task requires them.
- CLI context grammar, exactly one source kind per invocation:
  - JSON passed as a single shell argument, including escaped/quoted JSON such as
    `'{"filepath":"fixture/1"}'`;
  - `@file` reads JSON from a file, resolved against the invocation directory;
  - `name=value` pairs assign string values;
  - `name:=value` pairs parse `value` as JSON, so numbers, booleans, null, objects, and arrays
    are possible;
  - a bare argument is auto-wrapped when the schema declares exactly one required string
    property, producing `{ "<property>": <argument> }`;
  - a bare argument with no schema is passed as a JSON string.
- Multiple `name=value`/`name:=value` pairs are merged into one object; later assignments win.
  Mixing assignments with JSON or `@file`, malformed JSON, an unreadable `@file`, or an invalid
  `name:=value` is a usage error (exit 2). `name=value` always produces a string.
- The stored context is always the normalized JSON value after CLI path resolution. The task
  receives that parsed value in its execution context.

### D5 — Execution contract and log capture

The context passed to a task instance is the shape the sample tasks already implement:

```ts
interface ExecutionContext<TInput> {
  input: TInput;
  signal: AbortSignal;
  done: (exitCode: number) => void;
}
```

- The runner calls the task's default export, awaits it, and treats completion as success.
  Calling `done(0)` completes successfully; calling `done(nonZero)` or throwing marks FAILED.
  A task that returns without calling `done` is treated as exit code 0. The first terminal
  signal wins; a second `done` call or a throw after completion is ignored and recorded as a
  warning.
- The runner installs a single `console.log` / `console.error` interception at daemon start.
  Each execution runs inside an `AsyncLocalStorage` scope that identifies the active instance,
  so concurrent instances in one process still write to the correct log. Tasks print normally;
  they do not receive a logging API.
- Direct writes to `process.stdout` / `process.stderr` from a task, and output from child
  processes a task spawns, are not guaranteed to be captured. The documented contract is
  `console` output.
- Cancellation is cooperative: abort fires the instance's `AbortSignal`. The runner waits a
  grace period (5 seconds) for the task to settle, then releases the slot and returns the
  instance to PENDING regardless. If the task is still running after the grace period, the
  runner records a warning; late output and late state writes from that superseded attempt are
  discarded, so a retry cannot be corrupted by the old attempt.
- There is no automatic retry. A PENDING instance stays PENDING until a queue runs it.

### D6 — State machines

Task instance:

```
PENDING → RUNNING → SUCCESS
PENDING → RUNNING → FAILED          (non-zero exit, throw, or timeout)
RUNNING → abort → PENDING           (partial log preserved; queue becomes STOPPED)
```

Queue:

```
IDLE ⇄ PROCESSING
PROCESSING → STOPPED                (stop, or abort)
STOPPED → PROCESSING                (start)
PROCESSING → IDLE                   (drained: nothing running, nothing pending)
```

- IDLE means "draining is allowed, but there is nothing to do". A PENDING instance added to an
  IDLE queue is picked up automatically.
- STOPPED means "draining is not allowed". A PENDING instance added to a STOPPED queue waits.
- Control state is persisted, so a STOPPED queue stays STOPPED across a restart.

### D7 — Queue control semantics

- `stop`: stop launching new instances; let RUNNING instances finish; queue ends STOPPED.
- `start`: queue enters PROCESSING and drains PENDING instances in enqueue order.
- `abort`: signal the current RUNNING instance(s), return them to PENDING with their partial
  logs, and leave the queue STOPPED. Abort does not start any pending work.
- Drain order is FIFO by instance id within a queue.
- A task definition always has exactly one queue, and the queue id equals the task id.

### D8 — Persistence and recovery

- A per-project data directory (default `.task-runner/` in the project root) holds the SQLite
  database, a daemon descriptor file, and the log directory. It is overridable by environment
  variable and CLI flag and is added to `.gitignore`. The CLI and daemon use the same resolver
  (D9), so they always open the same database for a project.
- SQLite is used for structured state only: task definitions, queues, instances, and pending
  control requests. Instances store the task id, normalized input, state, attempt number, exit
  code, failure reason, timestamps, and log location. Instance ids are monotonically increasing
  integers per project database and are the handle used by the CLI, the API, and the dashboard.
- Control requests are durable rows with a kind (`abort` or `reload`), the targeted queue and
  instance ids, a creation time, and a consumed time. They are the only cross-process command
  channel; the daemon consumes them on its runner poll tick (D10).
- Logs are one append-only JSONL file per instance, with records carrying a timestamp, stream
  (`stdout`/`stderr`), and text. This preserves interleaving, supports streaming a running
  instance, and keeps large output out of SQLite. A retry appends to the same file; it is not
  truncated, so the aborted or crashed attempt's output is retained.
- On daemon start:
  - instances left RUNNING are reset to PENDING so they are retried, and their attempt number
    is incremented so `attempt` counts every execution that started;
  - queues that were STOPPED remain STOPPED;
  - all other queues enter PROCESSING (autostart).
- The daemon writes a descriptor with its pid and bound port on start and removes it on clean
  shutdown.

### D9 — Daemon configuration

- Resolution order is CLI flag, then environment variable, then the project's default. The CLI
  and daemon share this resolver. There is no config file in v1.
- Defaults: data directory under the project, HTTP on `localhost:3000`, 30-minute instance
  timeout, concurrency 1 per task unless the manifest says otherwise.
- `tq daemon` accepts `--data-dir` and `--port`; the other commands accept `--data-dir` so an
  offline command can find the same database. Only the daemon uses `--port`/`TQ_PORT`; CLI
  commands never need the HTTP port. `--port 0` binds an ephemeral port (used by tests).
- A port conflict is a startup error, not a silent port change. Tests use an ephemeral port.

### D10 — Core, CLI, and daemon behavior

- All task-runner behavior lives in a transport-independent core. The core owns input
  validation, database access, queue transitions, enqueueing, clear, log reads, reload
  discovery, and install/lockfile updates. It returns typed results and does not parse CLI
  flags, print terminal output, build HTTP responses, or emit dashboard events.
- Core operations cover every user-facing action: enqueue, list queues/status, queue detail,
  start/stop/abort, clear, list tasks/config, instance detail, read log, reload, and install.
  Not every core operation needs an HTTP route; `config` and `install` are CLI-only adapters.
- Core errors are typed with stable codes and human-readable messages. The CLI maps them to
  exit codes and stderr; HTTP maps them to status codes and JSON error bodies. Neither adapter
  invents its own validation or queue rules.
- The CLI opens the resolved data directory directly and calls core functions in-process. It
  never calls the daemon's HTTP API: no `fetch`, no `/api/...` requests, no dependence on the
  daemon port, and no HTTP health probe. Commands behave the same with zero, one, or many
  daemons listening; the daemon is not an intermediary for CLI commands.
- The HTTP API is another adapter over the same core functions (D11). It only validates
  transport input, calls core, and serializes results; it never carries queue or instance
  rules of its own.
- `add`, `status`, `config`, `logs`, `clear`, and `install` operate offline against SQLite and
  log files. The daemon polls for newly PENDING instances at about one second, so work
  enqueued while it was down is picked up promptly after it starts.
- Commands that act on the live runner (`start`, `stop`, `abort`, `reload`) require a running
  daemon and fail clearly with a non-zero exit otherwise. Liveness is determined from the
  daemon descriptor and pid, never by an HTTP request.
- Because the CLI and daemon are separate processes, daemon-directed operations use durable
  control requests in SQLite:
  - `start` and `stop` write the queue's target state directly. The runner reads queue state on
    every tick, so no request row is needed.
  - `abort` writes an abort request with the targeted queue and its RUNNING instance ids. On
    its next tick the daemon signals those instances' `AbortController`s, returns them to
    PENDING with partial logs preserved, and leaves the queue STOPPED. The core operation waits
    a bounded time for the request to be consumed so the caller can report the result; timeout
    is a runtime failure.
  - `reload` performs discovery and database updates through core, then writes a reload request
    and waits (bounded) for it to be consumed, so module re-import and queue refresh have
    applied before the command returns. A timeout is a runtime failure.
  - A request is consumed at most once. Requests left by a crashed daemon are replayed on the
    next start; a stale abort request for instances that are no longer RUNNING is discarded
    safely.
- `install` works offline: it updates the package and lockfile, then writes a reload request
  when a daemon is live instead of calling it over HTTP.
- Exit codes: 0 success; 1 runtime failure; 2 usage, unknown task, malformed input, or schema
  violation.
- The enqueue core result includes the instance id and its persisted creation timestamp, so
  `add` can print both without a second lookup or an HTTP round trip.
- `add` prints the instance id, creation time, task id, and normalized context to stdout:
  `Enqueued instance <id> at <ISO-8601 UTC>`, followed by `Task: <task-id>` and
  `Context: <compact JSON>`. The timestamp is the instance's persisted creation time.
- `-v` / `--verbose` is a global, repeatable CLI flag. Diagnostics go to stderr so stdout stays
  machine-readable. Level 1 prints the resolved project and data directory, task id, and
  normalized context; level 2 also prints the schema path/body and database path. Normal
  command output does not change.
- `status` prints one line per queue with state, concurrency, running count, and pending count.
  `logs <instance-id>` prints the merged log.
- `clear <queue>` deletes SUCCESS instances and their logs. `clear --all <queue>` deletes all
  finished instances and logs; it refuses and lists the running ids if any instance is
  RUNNING.

| Command                    | Behavior                                                            |
| -------------------------- | ------------------------------------------------------------------- |
| `tq daemon`                | Start the HTTP server, dashboard, and runner loop; queues autostart |
| `tq add <task> [context]`  | Validate context, enqueue, print id/time/task/context               |
| `tq start <queue>`         | Begin draining pending instances                                    |
| `tq stop <queue>`          | Finish running instances, start nothing new                         |
| `tq abort <queue>`         | Cancel running instances back to PENDING, leave the queue stopped   |
| `tq clear [--all] <queue>` | Delete SUCCESS instances (or all finished instances) and their logs |
| `tq status`                | Print queue state, concurrency, running, and pending counts         |
| `tq logs <instance-id>`    | Print the merged stdout/stderr log                                  |
| `tq install <package>`     | Install a task package and record it in the lockfile                |
| `tq reload`                | Re-read task definitions and apply changes                          |

### D11 — HTTP and event contract

- The HTTP API is an adapter over the core in D10, not a second implementation. Every handler
  parses and validates the request, calls the corresponding core operation, and serializes the
  result or a structured error. Handlers contain no queue-transition, enqueue, clear, or reload
  business logic.
- The API and dashboard are optional for CLI operation. Stopping or blocking HTTP must not
  affect any CLI command.
- Core mutations do not know about SSE. The task lifecycle publishes state-change events through
  an injected event sink after its transaction commits; the daemon adapter subscribes to the bus
  and translates events into the queue and instance event streams. Core and runner code must not
  import the HTTP adapter.
- REST endpoints (`Bun.serve` serves both the JSON API and the dashboard assets):

| Endpoint                             | Purpose                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `GET /api/health`                    | Liveness plus daemon pid, port, data directory, and started-at              |
| `GET /api/queues`                    | List queues with state, concurrency, running and pending counts, and totals |
| `GET /api/queues/:queueId`           | Queue detail                                                                |
| `GET /api/queues/:queueId/instances` | Instances for a queue, newest first, with optional state filter             |
| `POST /api/queues/:queueId/start`    | Start a queue                                                               |
| `POST /api/queues/:queueId/stop`     | Stop a queue                                                                |
| `POST /api/queues/:queueId/abort`    | Abort current RUNNING instances and stop the queue                          |
| `GET /api/tasks`                     | Registered task definitions with name, category, concurrency, and schema    |
| `POST /api/instances`                | Validate context against the task schema; enqueue (`{ task, input }`)       |
| `GET /api/instances/:id`             | Instance detail                                                             |
| `GET /api/instances/:id/log`         | Merged log content (JSONL parsed into ordered records)                      |
| `GET /api/events`                    | Server-sent events for queue and instance state changes                     |
| `GET /api/instances/:id/log/stream`  | Server-sent events: replay the log from the start, then follow              |
| `POST /api/reload`                   | Reload task definitions                                                     |

- `POST /api/instances` returns 400 `INPUT_SCHEMA_VIOLATION` with `{ code, message, issues }`
  when the context does not match the task schema, and creates no instance. Unknown tasks
  return 404 `TASK_NOT_FOUND`; malformed JSON returns 400 `INVALID_JSON`.
- The HTTP API does not resolve `format: "path"` values. API clients send absolute paths when
  a task requires them.
- Queue id is the task id (`namespace:id`). Unknown queue or instance ids return a
  structured error with a stable code and a human-readable message.
- Slow event consumers are dropped rather than buffered without bound.
- The dashboard is read-only in v1: no start/stop/abort buttons. Operational commands stay on
  the CLI and API.
- Dashboard content: queue table (id, name, category, state, concurrency, running, pending,
  succeeded, failed), an instance table per queue (id, state, exit code, duration, enqueue
  time), and an instance view with merged stdout/stderr that tails live. Counts and states
  arrive over the event stream; a mid-run page load gets current state immediately.

### D12 — Redaction

- Redaction is owned by tasks, not by the runner or the dashboard. The `cat` and `env` sample
  tasks scan their own output and replace sensitive-looking values with `[REDACTED]`.
- The runner and dashboard do not re-redact, so byte-exact task output is preserved for tasks
  that need it.
- Redaction is best effort: it reduces accidental exposure, it is not a security boundary.

### D13 — Packaging and installation

- `install <package>` adds the package with Bun, locates its `tasks/` directory, and records
  the package and its namespace in a lockfile alongside the project. Discovery reads the
  lockfile; tasks execute from the installed location, so package dependencies resolve
  normally.
- No extraction into the user directory in v1.
- Namespaces declared by installed packages must not collide with `default`; collisions are
  reported as load warnings.

### D14 — Sample tasks

- `ls`, `cat`, `env`, `sha256`, and `minfo` are real task definitions under the project search
  path, each with entrypoint, README, settings, and schema, all adapting the existing logic to
  the execution context.
- `minfo` imports shared media helpers from a package-level shared module, demonstrating
  cross-task code sharing.
- `cat` and `env` keep their current redaction rules.
- File-operating sample tasks mark path string properties with `"format": "path"` in their
  schemas so the CLI resolves relative paths before validation.
- A task that depends on an external tool (`minfo` on `mediainfo`) must fail with a clear
  message when that tool is absent.

## Testing Decisions

### What makes a good test here

Test observable behavior at the system's outer surface: what a user enqueues, what the CLI
prints and exits with, what the API and event stream report, what appears in the dashboard data,
and what survives a restart. Exercise queue and instance semantics by calling core functions
directly; treat the CLI and HTTP API as adapters. Do not assert on internal tables, private
functions, file layout, or timing internals. Prefer waiting for a state change (poll or event)
over fixed sleeps. Assert on log content and instance states, not on the SQL that produced them.

### Seam A — core operations (primary)

Tests call core functions directly in-process against an isolated environment: a temporary data
directory, a temporary project task folder, fixture task packages, and a runner driven by
explicit ticks. No HTTP server is started and no request is made. This seam covers task
discovery and namespaces, manifest and schema validation, queue creation, autostart, FIFO
draining, concurrency limits, stop/start/abort, exit-code mapping, log capture, log reads,
persistence, and crash recovery.

Fixture tasks needed at this seam: a success task, an explicit-failure task, a throwing task,
a slow task that honors the abort signal, a noisy task writing to both streams, an echo task
that prints its input, a task with no schema, and a task whose manifest is invalid or
conflicting. The slow task is what makes concurrency and stop/abort deterministic.

Representative tests:

- enqueue before runner start, then start the runner, and observe autostart drain;
- FIFO order within a queue;
- concurrency limit never exceeded and full utilization reached;
- stop lets RUNNING finish, leaves PENDING untouched, and reports STOPPED;
- start resumes and drains the remaining PENDING instances;
- abort writes a control request, the runner consumes it on the next tick, the instance returns
  to PENDING, partial output is preserved, the queue stops, and a later start retries it once;
- immediate abort also stops the queue;
- enqueue into a STOPPED queue stays PENDING; enqueue into an IDLE queue starts;
- exit 0 → SUCCESS, non-zero and throw → FAILED, timeout → FAILED with `timeout`;
- stdout/stderr interleaving is preserved when logs are read back;
- schema violation, malformed JSON, and unknown id are rejected without creating an instance;
- schema violation returns `INPUT_SCHEMA_VIOLATION` with field paths and creates no row;
- valid context matching required/enum/min/max/type constraints is accepted; schema-less tasks
  accept arbitrary values;
- bare-string wrapping only applies to the single-required-string schema case;
- clear removes SUCCESS rows and log files; clear --all refuses while an instance is RUNNING;
- restart resets RUNNING to PENDING, preserves STOPPED queues, and keeps finished instances;
- reload picks up a new task folder and a changed concurrency, and reports conflicts.

### Seam B — `tq` CLI subprocess (secondary)

Spawn the real binary against the same isolated environment. Cover only what is genuinely
CLI-shaped: argument parsing, help output, exit codes (0/1/2), the `add` output (id, time, task,
context), `status` and `logs` formatting, unknown-task and invalid-input errors, every context
source (JSON, `@file`, `name=value`, `name:=value`, bare string), relative path resolution
against the invocation directory, `-v` diagnostics on stderr, `add` with no daemon followed by
daemon pickup, control commands failing clearly with no daemon, control commands reaching a live
daemon through durable control requests, and `clear --all` refusal. A CLI test must not depend
on an HTTP listener: run with the descriptor pointing at an unused port (or with the API
disabled) and verify commands still work. A guard test must fail if the CLI exercises HTTP.

Everything else belongs at Seam A; do not duplicate the queue-state suite through the CLI.

### Seam C — HTTP adapter (contract)

Start the HTTP adapter over an isolated core and runner. Cover status codes, request
validation, structured error codes, SSE queue and instance events, log streaming, and dashboard
data. In particular, `POST /api/instances` must return 400 `INPUT_SCHEMA_VIOLATION` with field
issues and create no instance, matching the core result. For operations shared with the CLI,
assert that the HTTP result matches the core result; the adapter must add no queue or instance
rules of its own.

### Prior art and harness

- `tasks/test-cases/run-all.ts` is the existing prior art for driving tasks through their
  execution context, but it is an ad-hoc harness: it mocks `done` and `console`, waits a fixed
  5 ms, and does not use a real runner. Treat it as a source of fixtures and expected task
  behavior, not as the test architecture. Migrate its assertions into the real suite and leave
  the fixtures in place.
- Use Bun's built-in test runner; there is no test runner configured in the repo yet.
- `mediainfo` is unavailable in some environments. Detect it and skip the `minfo` success case
  rather than weakening the test; keep its failure-path test unconditional.

## Out of Scope

- Systemd/launchd/reboot autostart of the daemon.
- Per-instance process isolation, sandboxing, worker threads, or containers.
- Priority queues, weighted scheduling, or cross-queue fairness.
- Automatic retry, backoff, or dead-letter handling.
- Log retention policies, archival, rotation, or a non-destructive `tq archive`.
- Dashboard controls (start/stop/abort buttons) and any authenticated or multi-user dashboard.
- A configuration file; v1 config is flags, environment variables, and defaults only.
- Remote daemons, multiple daemons per project, or a shared/global daemon.
- Task-level environment injection (`env` in the manifest is reserved and ignored).
- Server-side resolution of relative `format: "path"` values for HTTP clients; API clients send
  absolute paths.
- Guaranteed capture of direct `process.stdout` writes or of child processes spawned by a task.
- Multiple runtime/agent descriptors affecting execution; descriptors are presentation hints.
- Long-running service tasks where one instance stays RUNNING indefinitely.

## Further Notes

- **Settled here from previously open issues:** explicit schemas with a schema-less fallback,
  console interception via `AsyncLocalStorage`, trusted in-process tasks with a timeout as the
  safety net, a transport-independent core shared by the CLI and HTTP API, no HTTP calls from
  the CLI, durable control requests consumed by the runner poll loop for daemon-directed abort
  and reload, CLI liveness checked from the descriptor pid instead of an HTTP health probe,
  destructive clear with RUNNING protected, read-only dashboard in v1, install from the
  installed package location discovered through the lockfile, project-first precedence with
  first-match-wins, no config file in v1, and reload re-reading manifests and task code.
- **Adapter rule:** CLI and HTTP behavior must not diverge. Add or change a core function first;
  CLI and HTTP adapters only parse input, call core, format output/errors, and stream events. A
  behavior implemented in only one adapter is a spec violation.
- **Cancellation caveat:** in-process tasks cannot be forcibly killed. A task that ignores
  `AbortSignal` will keep running after its instance has been returned to PENDING and its slot
  released. The documented contract is that task authors must honor the signal; the runner
  fences late writes so retries stay correct. This is the accepted cost of the trusted,
  single-process model.
- **Existing artifacts:** `SPEC.md` was a design log with an open-issues appendix. This
  document supersedes it as the buildable spec. `ISSUES.md` remains as history; items not
  reflected above are either decided here or explicitly out of scope.
- **Sample-task caveat:** the existing `test-cases` harness records five "expected failures"
  that come from its own cwd and timeout gaps, not from task bugs. Those gaps are not a
  specification; the new suite must assert real behavior against the runner.
- **Tracker setup:** this repo has no git remote and no issue tracker configuration, so the spec
  is published under the local-markdown convention. Running `/setup-matt-pocock-skills` would
  formalize `docs/agents/` and the label vocabulary if a real tracker is added later.
