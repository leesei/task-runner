# Task Runner — Specification

## 1. Overview

A Bun-based CLI daemon that registers **tasks** (from folders on a search path, like `$PATH`), enqueues **task instances** via `tq add <namespace:id> <context>`, and runs them with per-queue concurrency limits. A web dashboard (served by the daemon) shows queue/task state and streams logs in real time. State and metadata persist to SQLite (via Bun's built-in SQLite API); logs are files on disk.

This document captures the design settled in discussion and the open issues still to clarify.

---

## 2. Glossary

- **Task definition** — a registered task: its identity (`namespace:id`), input schema, settings, entrypoint, README, assets.
- **Task instance** — one execution of a task definition: a PENDING → RUNNING → SUCCESS/FAILED lifecycle with captured stdout/stderr, timing, and exit code.
- **Task queue** — one per task definition. Holds PENDING instances and tracks RUNNING count against the concurrency limit. Queue states: IDLE / PROCESSING / STOPPED.
- **Task package** — a Bun package that can contain multiple task definitions under a `tasks/` directory, plus shared code at the package root.
- **Search path** — a directory the daemon walks to discover task definitions (project `tasks/`, user `~/.taskrunner/tasks/`, installed-package locations).
- **Namespace** — a task identity prefix separated by `:`. `default` is the implicit namespace for project + user search paths; other namespaces come from installed packages.
- **Context / input** — the structured payload a task instance receives. Validated against the task's input schema at enqueue time.
- **Runtime descriptor** — per-"runtime" metadata for a task (daemon view, CLI view), modeled on agent-skills' `agents/<runtime>.yaml`.

---

## 3. Architecture — settled decisions

### 3.1 Process model

- Single daemon process (`tq daemon`).
- Task instances run as concurrent coroutines **in the same process**, launched by the runner with an `AbortSignal` and wrapped in error handling.
- Tasks are **trusted code** (installed by the user). Process isolation is future hardening, not today's scope.
- Bun's strengths are leveraged directly: Bun's built-in SQLite API, `Bun.serve`, `Bun.$` / `$` for spawning child commands inside a task, `Bun.sleep` / event-loop scheduling.

### 3.2 Task identity and lookup

- Identity is `namespace:id`, e.g. `default:minfo`, `acme:encode`. The `:` separator is used from the start.
- A task is **one folder** containing at minimum: `index.ts` (entrypoint), `README.md`, `settings.json` (task settings), and optionally `schema.json` (input schema) and `agents/<runtime>.json` (runtime descriptors).
- A **task package** is a Bun package whose `tasks/` directory holds one subfolder per task. Shared code lives at the package root (or `lib/`) and tasks import it via relative paths.
- Discovery is `$PATH`-like: the daemon walks search paths, reads each task folder's manifest, and builds an index mapping `namespace:id` → folder location + manifest.
- Identity (namespace + id) is **declared in the task's manifest**, not inferred from the folder name.

### 3.3 Input / context convention

- Each task declares its input shape via `schema.json` (JSON Schema draft-07) referenced from `settings.json` (or inlined).
- At `tq add <namespace:id> <context>`, the CLI sends the context; the registry parses + validates it against the schema before enqueueing.
- The task's `default` receives the **parsed, validated input object**.
- CLI convenience: when the schema has exactly one required string property, `tq add <id> <bare-string>` auto-wraps to `{"<prop>": "<bare-string>"}`. The authoritative input is always JSON validated against the schema.
- Existing sample tasks (`ls`, `minfo`) declare `{ type: "object", properties: { filepath: { type: "string" } }, required: ["filepath"] }` and are used as `tq add default:ls '{"filepath":"fixture/1"}'` (or the convenience form `tq add default:ls fixture/1`).

### 3.4 Execution contract

- Runner invokes: `default(ctx: ExecutionContext) → Promise<void>`, where task entrypoint `index.ts` exports `runWith(ctx)` and sets `default = runWith`.
- `ExecutionContext` provides: parsed input, `AbortSignal` (for `abort`), a stdout/stderr capture mechanism (streams or log callbacks), and a completion signal (callback or thrown error).
- Runner owns **observability**: captures stdout/stderr, measures duration, transitions state. Task owns **execution**.
- One `default` invocation = one task instance = one lifecycle. "Task implements its own scheduling" means the task logic may internally schedule sub-work, but from the runner's view it is one atomic instance.
- Exit mapping: runner treats clean completion with exit code 0 as SUCCESS; non-zero exit or thrown error as FAILED. `abort` cancels the coroutine (and any child process the task spawned via `$`), preserves partial logs, and resets the instance to PENDING for retry.
- **Sensitive-data redaction** is a task-level concern in the current samples: `cat` and `env` redact sensitive-looking values in their own output before printing (best-effort pattern scan). The runner/dashboard do not re-redact. Reconcile which layer owns redaction before the dashboard ships (see ISSUES.md §ExecutionContext capture mechanism).

### 3.5 Queue model

- One queue per task definition. Queue ID == task identity.
- Per-queue concurrency configured in `settings.json` (e.g. `"concurrency": 3`).
- Queue states: IDLE ⇄ PROCESSING ⇄ STOPPED.
  - IDLE: queue exists, no RUNNING tasks, not actively draining (empty or freshly created).
  - PROCESSING: actively draining PENDING tasks up to concurrency.
  - STOPPED: finished current RUNNING tasks, will not start next PENDING.
- `stop`: complete current RUNNING, do not start next PENDING → PROCESSING → STOPPED.
- `start`: resume → STOPPED → PROCESSING (PENDING tasks remain and are picked up in order).
- `abort`: kill current RUNNING, reset to PENDING, do not start next PENDING.
- Drain order: FIFO / insertion order.

### 3.6 Persistence

- SQLite via Bun's built-in SQLite API. DB holds: task definition registry, task instances (state, input, exitCode, timing, error), queue state, concurrency, running count.
- Logs (stdout/stderr) are **files on disk** in `logs/` (already in `.gitignore`), referenced by path from the DB. Reasoning: logs can be large; SQLite is for structured lookups/dashboard queries.
- DB location: configurable, default `./taskrunner.db` in the daemon's working directory (per-project DB); override via `--db` flag or `TASKRUNNER_DB` env var.

### 3.7 Autostart

- "Autostart" = on `tq daemon`, all registered queues automatically enter PROCESSING and begin draining PENDING tasks.
- No systemd/reboot autostart in scope.
- `tq add` writes to the DB directly, so tasks can be enqueued before the daemon runs; they are picked up on `tq daemon` or `tq start`.

### 3.8 Dashboard

- Web UI served by the daemon's HTTP server (Bun.serve), minimal HTML at `/`.
- Real-time updates via SSE (state changes + log tailing).
- REST API on the same server:
  - `GET /` — dashboard HTML
  - `GET /api/queues` — list queues
  - `GET /api/queues/:id` — queue detail (state, concurrency, running count, task count)
  - `GET /api/queues/:id/tasks` — tasks in queue (with state)
  - `GET /api/tasks/:id` — task instance detail
  - `GET /api/tasks/:id/logs` — log file content
  - `GET /api/tasks/:id/logs/stream` — SSE log stream
  - `POST /api/queues/:id/start` — start queue
  - `POST /api/queues/:id/stop` — stop queue
  - `POST /api/queues/:id/abort` — abort current instance
  - `POST /api/tasks` — enqueue task (API equivalent of `tq add`)

### 3.9 CLI (`tq`)

- Same binary, two modes:
  - `tq daemon` — start HTTP server + runner loop.
  - `tq <subcommand>` — add, stop, start, abort, clear, status, logs, install, reload.
- `tq` talks to a running daemon over HTTP when available; degrades to direct SQLite/DB access when the daemon is not running.
- `tq add` writes to the DB directly (works without the daemon).
- Sample workflow (from the prompt, adapted to namespace:id):

```sh
tq daemon          # starts service; registered tasks autostart

tq add default:ls fixture/1
tq add default:ls fixture/2
tq add default:minfo fixture/1
tq add default:minfo fixture/2

tq stop default:ls
tq start default:ls
tq abort default:minfo

tq clear default:ls        # clear SUCCESS tasks
tq clear --all default:ls  # clear all tasks
```

---

## 4. File and directory layout

### 4.1 Project layout (this repo)

```
.
├── index.ts            # daemon entrypoint (TBD)
├── package.json
├── bun.lock
├── tsconfig.json
├── SPEC.md             # this file
├── tasks/              # project task search path (default namespace)
│   ├── ls/
│   │   ├── index.ts
│   │   ├── README.md
│   │   ├── settings.json
│   │   └── schema.json
│   ├── minfo/
│   │   ├── index.ts
│   │   ├── README.md
│   │   ├── settings.json
│   │   └── schema.json
│   ├── cat/
│   │   ├── index.ts
│   │   ├── README.md
│   │   ├── settings.json
│   │   └── schema.json
│   ├── env/
│   │   ├── index.ts
│   │   ├── README.md
│   │   ├── settings.json
│   │   └── schema.json
│   ├── sha256/
│   │   ├── index.ts
│   │   ├── README.md
│   │   ├── settings.json
│   │   └── schema.json
│   └── lib/
│       └── media.ts     # shared module imported by multiple tasks
├── fixture/
│   ├── 1/1.srt
│   └── 2/2.srt
├── logs/               # task instance logs (gitignored)
└── taskrunner.db       # SQLite DB (gitignored, configurable via --db / TASKRUNNER_DB)
```

### 4.2 Task folder contents

A task folder (e.g. `tasks/minfo/`) contains:

| File | Purpose |
|---|---|
| `index.ts` | Entrypoint: exports `runWith(ctx: ExecutionContext) => Promise<void>` and `default = runWith` |
| `README.md` | Human documentation for the task |
| `settings.json` | Task settings: concurrency, env, inputSchema ref, schedule ref, metadata, category |
| `schema.json` | *(optional)* JSON Schema for the input; if absent, input is an opaque string |
| `agents/<runtime>.json` | *(optional)* per-runtime descriptor (daemon, cli, …) |

A task **package** root (e.g. an installable bun package) additionally has:

```
my-package/
├── package.json          # bun package: name, version, dependencies, "tasks": ["ls","minfo"]
├── lib/                  # shared code imported by tasks via relative paths
│   └── media.ts
└── tasks/
    ├── ls/
    └── minfo/
```

### 4.3 Lockfile

A lockfile (e.g. `.taskrunner.lock` or `taskrunner-lock.json`) maps `namespace:id` → `{ source, installedPath, manifestHash }`, analogous to agent-skills' `skills-lock.json`. The daemon reads it to know installed-package task locations.

---

## 5. Task manifest and schema — illustrative shape

### 5.1 `settings.json` (task settings)

```json
{
  "namespace": "default",
  "id": "minfo",
  "name": "Media info",
  "description": "Print media information for a video/audio file",
  "concurrency": 1,
  "inputSchema": "schema.json",
  "env": {},
  "agents": {
    "daemon": { "logPath": "logs" },
    "cli": { "argumentHint": "<filepath>", "example": "tq add default:minfo fixture/1" }
  }
}
```

### 5.2 `schema.json` (input schema)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "filepath": { "type": "string" }
  },
  "required": ["filepath"]
}
```

### 5.3 `agents/cli.json` (CLI runtime descriptor)

```json
{
  "display_name": "Media info",
  "short_description": "Print media information for a video/audio file",
  "argument_hint": "<filepath>",
  "example": "tq add default:minfo fixture/1"
}
```

---

## 6. ExecutionContext interface (TypeScript shape)

```ts
interface ExecutionContext<TInput> {
  input: TInput;
  signal: AbortSignal;
  stdout: WritableStream | LogSink;
  stderr: WritableStream | LogSink;
  done: (exitCode: number) => void;
}
```

The runner wraps `default(ctx)` and, regardless of outcome, transitions the instance state and captures logs/timing. The task calls `ctx.done(0)` on success or throws / calls `ctx.done(nonZero)` on failure.

---

## 7. State machine summary

### 7.1 Task instance states

PENDING → RUNNING → SUCCESS
PENDING → RUNNING → FAILED
RUNNING → (abort) → PENDING (retry, partial logs preserved)

### 7.2 Queue states

IDLE → PROCESSING (when a task is launched and queue becomes active)
PROCESSING → STOPPED (on `stop`)
STOPPED → PROCESSING (on `start`)
PROCESSING → IDLE (when queue empties and no RUNNING tasks remain)

---

## 8. CLI command reference (settled)

| Command | Meaning |
|---|---|
| `tq daemon` | Start the daemon (HTTP server + runner loop); queues autostart |
| `tq add <namespace:id> <context>` | Enqueue a task instance (writes DB directly) |
| `tq stop <namespace:id>` | Stop queue: finish RUNNING, don't start next PENDING |
| `tq start <namespace:id>` | Resume queue: start processing PENDING |
| `tq abort <namespace:id>` | Kill current RUNNING, reset to PENDING, don't start next |
| `tq clear <namespace:id>` | Delete SUCCESS instances (+ logs) for the queue |
| `tq clear --all <namespace:id>` | Delete all instances (except RUNNING) + logs |
| `tq status` | Show queue/instance state (from DB or daemon API) |
| `tq logs <instance-id>` | Show task instance logs |
| `tq install <package>` | Install a task package, extract tasks/, update lockfile |
| `tq reload` | Reload task discovery from search paths (SIGHUP alternative) |

---

## 9. Open issues / further discussion

These are still to clarify or implement; listed here as requested ("log issues we would further discuss and clarify").

### 9.1 Input schema — inference vs. explicit

- **Issue**: We chose explicit `schema.json` over inferring the input shape from the TS signature of `default`. Confirm this is right, and decide whether to support a *minimal* task (no schema → input is a plain string) as a first-class convenience, or always require a schema.
- **Impact**: affects `tq add` parsing logic and how bare-string convenience wrapping works.

### 9.2 `ExecutionContext` capture mechanism

- **Issue**: The `stdout`/`stderr` capture in `ExecutionContext` is underspecified: is it a `WritableStream` the task writes to, a `log(str, isErr)` callback the task calls, or does the runner intercept `console.log`/`console.error` globally for the task's execution? Each has different ergonomics for tasks that use `console.log` (like the current `minfo.ts`).
- **Impact**: affects the task entrypoint contract and how existing sample tasks are adapted.

### 9.3 Same-process isolation guarantees

- **Issue**: We chose same-process task execution with trusted tasks. Need to define what happens on: unhandled error (runner catches → FAILED), infinite loop (instance hangs → abort required), memory leak (no isolation → affects daemon). Decide whether to document these as "trusted tasks" caveats now, or add a lightweight per-instance timeout as a safety net.
- **Impact**: affects robustness posture and whether `tq abort` needs a per-instance timeout.

### 9.4 `tq` degradation behavior

- **Issue**: `tq` talks HTTP to the daemon when available, direct DB otherwise. Open: how does `tq` detect the daemon is running? (TODO: check a PID file, a lock file, or try the API and fall back.) And does `tq add` via direct DB require the daemon to be notified (e.g. a wake-up signal) or is polling on the daemon side fine?
- **Impact**: affects CLI implementation and daemon wake-up semantics.

### 9.5 Log retention and clear semantics

- **Issue**: `clear` is destructive (delete instance rows + log files). Open: should there be a retention policy (e.g. auto-clear SUCCESS older than N days), a non-destructive archive (`tq archive`), or per-instance log rotation? Also: can `clear --all` remove RUNNING instances? (Currently: no — refuses/aborts RUNNING.)
- **Impact**: affects `tq clear` behavior and log lifecycle.

### 9.6 Dashboard — command exposure

- **Issue**: The dashboard is read-only + SSE; commands go through CLI or REST API. Open: do we want in-dashboard controls (start/stop/abort buttons) that call the REST API from the browser, or keep the dashboard strictly observational and push all ops to the CLI?
- **Impact**: affects dashboard UI scope.

### 9.7 Task package install mechanics

- **Issue**: `tq install <package>` is sketched as a convenience (bun install + extract `tasks/` + update lockfile). Open: where do installed package tasks land — `node_modules/<pkg>/tasks/` (discovered via the lockfile) or an extracted copy in `~/.taskrunner/tasks/<pkg>/`? And how are package dependencies of a task (e.g. a task that `import`s a third-party lib) resolved — does the daemon need the package installed, or are tasks bundled?
- **Impact**: affects install path, lockfile semantics, and module resolution for tasks.

### 9.8 Namespace shadowing and search-path order

- **Issue**: Search paths are walked in order (project `tasks/`, user `~/.taskrunner/tasks/`, installed-package locations). Open: is the first match the winner ( shadowing ), or do we merge/warn on conflicts? And can a user task in `~/.taskrunner/tasks/` shadow a project task with the same `namespace:id`?
- **Impact**: affects discovery semantics and conflict behavior.

### 9.9 Daemon configuration

- **Issue**: Configuration is underspecified: DB path, HTTP port, search paths, log directory, concurrency defaults. Open: is there a config file (`taskrunner.toml` / `taskrunner.json` / `.taskrunnerrc`), env vars, CLI flags, or a mix? And where does it live (project-level, user-level)?
- **Impact**: affects startup and portability.

### 9.10 `tq reload` and live task discovery

- **Issue**: We have `tq reload` (re-walk search paths, e.g. on SIGHUP). Open: does reload also re-read task manifests/schemas (so a changed `settings.json` takes effect without restart), or is reload only for newly added/removed task folders?
- **Impact**: affects operational model for updating tasks.

### 9.11 Sample tasks adaptation

- **Issue (resolved in sample)**: The sample tasks were `tasks/ls.ts` and `tasks/minfo.ts` exporting `default (filepath: string) => Promise<number>`. They have been restructured into task folders (`tasks/ls/`, `tasks/minfo/`) with `default.ts` entrypoints exposing `runWith(ctx)` + `default`, plus `README.md`, `settings.json`, `schema.json`. The minfo task now imports shared helpers from `tasks/lib/media.ts`, demonstrating the package-level sharing model.

- **Still open**: whether to keep the `runWith(ctx)` + `default` dual export or consolidate to a single `default(ctx)` export as the canonical entrypoint.
- **Impact**: affects the first batch of implemented tasks and whether the samples still work as before.

---

## 10. Out of scope (for now)

- Systemd/reboot autostart of the daemon.
- Per-instance process isolation (child-process sandboxing).
- Priority queues, explicit priorities, weighted scheduling.
- Non-destructive archive / retention policies (defer to `tq archive` + retention later).
- WebSocket bidirectional dashboard (SSE is enough for now).
- Multiple concurrent runtimes/agents per task beyond the daemon + CLI descriptors.
- Service tasks / long-running persistent workers (one instance = one `default` invocation for now).
