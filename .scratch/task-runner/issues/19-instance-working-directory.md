# 19: Record the invocation directory on every task instance

**Status:** done

**Blocked by:** None

## Problem Statement

When I run `tq add <task> [context]`, the task instance is queued, but it does not remember which directory I was in. The daemon runs every task from its own process directory, so a task that resolves a relative path, spawns a command with a relative argument, or writes a file places the result somewhere I did not intend. This is especially confusing when:

- I enqueue work from a nested folder inside a project, but the daemon was started from the project root.
- I enqueue work offline, then start the daemon later from a different directory.
- I enqueue several instances of the same task from different directories and cannot tell from the instance list which directory each one belongs to.
- A task author uses `process.cwd()` or a shell helper without an explicit directory and gets the daemon's directory instead of the user's.

The existing `format: "path"` input resolution covers explicit file-path fields, but it does not cover tasks that do their own relative-path work, spawn tools, or use the working directory implicitly. There is no field on a task instance that says "run this where the user added it".

## Solution

Every task instance stores the absolute working directory it was enqueued from. `tq add` records the invocation directory automatically; the HTTP enqueue accepts an optional absolute `cwd` and defaults to the daemon's project root. The runner passes the stored directory to the task as `ctx.cwd`, and the task uses it for relative filesystem, shell, and subprocess work. The runner does not change the daemon's global `process.cwd()`, so concurrent tasks cannot corrupt each other's directory. The `ls` sample task demonstrates the contract: its path input becomes optional and, when omitted, lists the instance working directory. `tq add` prints the recorded directory so the user can confirm it.

## User Stories

1. As a CLI user, I want `tq add` to record the directory I ran it from, so that the task operates on the files I see in that directory.
2. As a CLI user, I want the recorded directory to be absolute, so that it remains correct after the daemon restarts from another directory.
3. As a CLI user, I want the recorded directory to survive daemon restarts and crash recovery, so that retried work keeps the same context.
4. As a CLI user, I want `tq add` to print the recorded working directory, so that I can confirm exactly what was stored.
5. As a CLI user, I want `-v` diagnostics to include the working directory, so that I can debug path problems without inspecting the database.
6. As a CLI user, I want to enqueue from a nested subdirectory, so that the task targets that subdirectory rather than the project root.
7. As a CLI user, I want to enqueue while the daemon is stopped and have the directory preserved when the daemon picks the instance up later, so that offline batches work as expected.
8. As a CLI user, I want an aborted instance to keep its working directory when it is retried, so that the retry does not silently change context.
9. As a CLI user, I want a crash-recovered instance to keep its working directory, so that recovery does not silently change context.
10. As a CLI user, I want `tq add default:ls` with no path to list the directory I added from, so that the working directory is immediately useful.
11. As a task author, I want `ctx.cwd` in the execution context, so that I can resolve relative paths without guessing where the daemon runs.
12. As a task author, I want `ctx.cwd` to always be an absolute path, so that I can join and pass it safely.
13. As a task author, I want `ctx.cwd` to stay stable for the whole instance, so that using it before and after an `await` gives the same answer.
14. As a task author, I want to pass `ctx.cwd` to shell and subprocess helpers, so that spawned tools run in the directory the user intended.
15. As a task author, I want the runner to leave the global process directory untouched, so that concurrent instances cannot corrupt each other's relative path resolution.
16. As a task author, I want an instance whose directory has disappeared to fail with a clear reason, so that I know why it failed instead of seeing an unrelated `ENOENT`.
17. As a task author, I want the missing-directory failure visible in the instance record and log, so that I can fix the enqueue or restore the directory.
18. As a task author, I want existing path-input behavior to remain unchanged, so that tasks using `format: "path"` do not need to be rewritten.
19. As an API client, I want to send an optional absolute `cwd` with an enqueue, so that a batch can target a specific directory.
20. As an API client, I want omitting `cwd` to default to the daemon's project root, so that existing clients keep working unchanged.
21. As an API client, I want a relative, non-existent, or non-directory `cwd` rejected before an instance is created, so that bad requests fail fast.
22. As an API client, I want the enqueue response to include the stored working directory, so that I do not need a second request to confirm it.
23. As an API client, I want instance detail and queue instance listings to include the working directory, so that I can audit and distinguish runs.
24. As a user, I want relative values in `format: "path"` fields to keep resolving against my invocation directory, so that existing CLI workflows do not change.
25. As a user, I want absolute path values to remain unchanged, so that explicitly addressed files are never rewritten.
26. As a user, I want an existing database to upgrade in place with no data loss, so that I do not have to reset my queues.
27. As a user, I want instances created before this change to remain runnable, falling back to the daemon's project root, so that pending work is not stranded.
28. As a user, I want the working directory recorded for API-enqueued instances too, so that the behavior is consistent across the CLI and HTTP surfaces.
29. As a maintainer, I want the CLI and HTTP adapters to store the working directory through the same core operation, so that the two surfaces cannot diverge.
30. As a maintainer, I want cwd validation in core, so that every adapter rejects the same values with the same stable error code.
31. As a maintainer, I want the lifecycle to remain filesystem-free, so that cwd is persisted as data and only execution touches the directory.
32. As a maintainer, I want the schema change to be an additive, idempotent migration, so that old databases open without manual steps.
33. As a maintainer, I want a single execution-context field for cwd, so that tasks never need to reach for process globals.
34. As a maintainer, I want the `claim` returned by the lifecycle to carry the working directory, so that execution does not need a second database read.

## Implementation Decisions

### Domain vocabulary

- Introduce the term **working directory** (also the invocation directory): the absolute directory from which a task instance was enqueued. It is stored on the instance, not read from the daemon's `process.cwd()` at execution time.
- Add the term to the glossary and clarify that it is distinct from the project root, which is where task discovery happens.

### Persistence

- Add a nullable `cwd` column to the instance record.
- Apply the column through the existing additive, idempotent migration path so that opening an older database succeeds without manual intervention.
- `NULL` means "not recorded by an older build". It is not rewritten; the lifecycle resolves it at claim time.
- No backfill and no rewrite of existing rows.

### Lifecycle

- Extend the lifecycle configuration with a `defaultCwd` (defaults to the process directory) used only for legacy rows whose stored cwd is `NULL`.
- Extend `enqueue` to accept an optional working directory and persist it with the instance. When omitted, the lifecycle stores `defaultCwd`.
- Include `cwd` in `Claim`, populated from the stored value or `defaultCwd` for legacy rows. Both `claim` and `claimQueue` share the same selection helper, so the field is present on every claim.
- The lifecycle continues to touch no filesystem: it validates nothing about the directory and only persists and returns the string.

### Core enqueue

- Change the core enqueue operation to accept an options object with an optional `cwd`.
- When `cwd` is supplied, require an absolute path that resolves to an existing directory; normalize with path resolution (remove redundant separators and trailing separators) but do not resolve symlinks, so the path the user chose is preserved.
- When `cwd` is omitted, use the core's project root. This keeps the HTTP default stable and independent of the caller's process directory.
- Reject an invalid value before any queue or instance write with a new stable error code, `INVALID_CWD`, carrying a human-readable message.
- Include the resolved working directory in the enqueue result so adapters can print or return it without a second read.

### CLI `add`

- Capture the invocation directory already supplied to the command and pass it to core.
- Print a `Working directory: <absolute path>` line with the existing enqueue output.
- Keep the existing `format: "path"` resolution against the invocation directory; the stored working directory and resolved input paths agree by construction.
- Map `INVALID_CWD` to exit code 2, consistent with other usage and validation errors.

### Execution context

- Add `cwd: string` to the execution context passed to a task's default export. It is always absolute for new instances and for legacy instances resolved through `defaultCwd`.
- The field is authoritative: task authors use `ctx.cwd` for relative filesystem access, shell invocation, and subprocess spawning.
- The runner explicitly does not call `process.chdir()`. This is a deliberate correctness decision: tasks are async and run concurrently across queues, and a process-global directory would be observed by another task after an `await`. The daemon's process directory stays whatever it was at start.
- Before importing the task module, execution checks that `cwd` exists and is a directory. If not, it records a failure with exit code 1 and reason `cwd_not_found`, and logs a clear message; the task is not invoked.
- No other execution-context fields change. Abort, timeout, completion fencing, and log capture are unaffected.

### HTTP API

- `POST /api/instances` accepts an optional `cwd` string in the request body alongside `task` and `input`.
- An omitted `cwd` uses the daemon's project root. A supplied value must be absolute and an existing directory; otherwise the API returns status 400 with `INVALID_CWD` and creates no instance.
- The enqueue response includes the resolved `cwd`.
- Instance detail and queue instance listings include `cwd` so clients can audit runs.
- The API continues not to resolve relative path values in task input; `cwd` is the only directory field the API accepts.

### Sample task

- The `ls` sample task's path input becomes optional. When omitted, the task lists the instance working directory (`ctx.cwd`). When supplied, existing `format: "path"` resolution still applies.
- Other sample tasks keep their required path inputs and continue to receive absolute paths from the CLI.

### Documentation

- Update the behavioural specification's input and execution-contract sections: the working directory is instance metadata, the CLI resolves `format: "path"` values against the invocation directory, and the runner never changes the process directory.
- Update the glossary with the working-directory term and its relationship to the project root.
- Document in the task-author guidance that relative work must use `ctx.cwd`.

## Testing Decisions

### What makes a good test here

Test observable behavior: what `tq add` prints and exits with, what the enqueue result and instance detail expose, what directory a fixture task actually observes through `ctx.cwd`, and what state an instance ends in when its directory is missing. Do not assert on column names, SQL, private helper functions, or the daemon's process directory. Prefer runner ticks and polling for a state change over fixed sleeps. A test should fail if the runner silently reverts to the process directory or if cwd is lost across a restart.

### Seam A — core and runner (primary)

Drive core enqueue, lifecycle claim, and execution with explicit runner ticks against temp directories and fixture tasks.

Cover:

- enqueue stores the supplied absolute working directory and exposes it in the enqueue result;
- a fixture task prints `ctx.cwd` and the captured log shows the enqueued directory, not the test process directory;
- enqueue with no explicit cwd uses the core project root;
- `INVALID_CWD` is returned for a relative path, a missing directory, and a path that is a file, and no instance is created;
- a legacy instance row with `NULL` cwd claims with `defaultCwd`;
- an instance whose directory is removed before execution ends FAILED with reason `cwd_not_found` and a clear log message, without invoking the task;
- the working directory survives closing and reopening the database, and is preserved through abort, retry, and boot recovery;
- two fixture instances with different cwds run concurrently and each observes its own `ctx.cwd` (guards against a reintroduced global `process.chdir`).

### Seam B — `tq` subprocess (one focused test)

Spawn the real binary from a nested temp directory, enqueue a fixture task that logs `ctx.cwd`, and verify:

- `tq add` prints the absolute invocation directory;
- the daemon, started from the project root, runs the task with that directory after picking the instance up;
- the offline path (add with no daemon, then start the daemon) preserves the directory.

This is the only CLI-shaped behavior that belongs at this seam; do not duplicate the core cwd suite through the CLI.

### Seam C — HTTP contract (one focused test)

Over the existing HTTP adapter with an isolated core, verify:

- `POST /api/instances` without `cwd` defaults to the project root;
- an absolute `cwd` is echoed in the response and readable from instance detail and the queue instance listing;
- an invalid `cwd` returns 400 `INVALID_CWD` and creates no instance, matching the core result;
- the adapter adds no directory rules of its own.

### Prior art

- Runner and execution tests that build fixture tasks, create a runner, and tick it explicitly are the closest prior art for Seam A.
- The existing CLI subprocess suite is the prior art for Seam B, including its offline-add then daemon-pickup case.
- The existing HTTP contract tests are the prior art for stable codes and "no instance created" assertions.

## Out of Scope

- Calling `process.chdir()` or introducing a cwd-group lease. The chosen design keeps concurrency correct by passing the directory to the task instead of mutating process state.
- Running each instance in a child process, worker thread, or container to obtain a real per-instance cwd.
- Canonicalizing or symlink-resolving the working directory; the user-facing path is preserved.
- Requiring the working directory to be inside the project root or a task folder.
- A `--cwd` flag on `tq add`; the invocation directory is implicit and the API is the explicit surface.
- Changing `format: "path"` resolution, including making the HTTP API resolve relative input paths.
- Backfilling working directories for instances created before this change.
- Showing cwd in the web dashboard; the API and CLI expose it.
- Per-task environment injection, which is already reserved and ignored.
- Cwd-aware scheduling, affinity, or concurrency changes.

## Further Notes

- **Why not `process.chdir()`:** the runner executes tasks in one process, but tasks are async. A task that yields after changing the global directory lets another task's relative work observe the wrong directory. Passing `ctx.cwd` is the only design that preserves the daemon's cross-queue concurrency without a global lock. If transparent cwd behavior is ever required for tasks that ignore `ctx.cwd`, revisit it as a separate decision with either a cwd-group lease or per-instance process isolation.
- **Legacy rows:** instances created before this change run in the daemon's project root, which matches today's behavior. This is deliberate: migration must not strand pending work or rewrite history.
- **Validation boundary:** enqueue rejects an invalid directory eagerly; execution still re-checks because a directory can disappear between enqueue and run. Both failures are explicit, not silent fallbacks.
- **Trust model:** the working directory is local, caller-chosen metadata in a trusted single-user tool. It is not a sandbox boundary.

## Comments

Implemented.

- `instances.cwd` added to the schema with an additive, idempotent `ALTER TABLE` in both the open and configure paths.
- The lifecycle stores `cwd` on enqueue, carries it on every `Claim`, and falls back to `defaultCwd` for legacy `NULL` rows. The daemon and CLI pass the project root as `defaultCwd`.
- Core validates an enqueue cwd: absolute, existing, directory. Invalid values throw `INVALID_CWD` before any row is written. The enqueue result includes the resolved directory.
- `tq add` passes the invocation directory and prints `Working directory: <path>`. `-v` prints both project root and working directory.
- `POST /api/instances` accepts optional `cwd`, defaults to the project root, returns 400 `INVALID_CWD`, and echoes `cwd`. Instance detail and queue listings include it.
- Execution adds `ctx.cwd`, checks the directory before importing the task, and fails with reason `cwd_not_found` plus a captured log line when it is gone. The runner never calls `process.chdir()`.
- The `ls` sample task's path input is optional and defaults to `ctx.cwd`.
- Docs updated: GLOSSARY working-directory term, SPECS D4/D5/D10/D11, DESIGN lifecycle interface.

Evidence: `bunx tsc --noEmit` clean; `bun run build` succeeds; `bun test` → 158 pass / 0 fail across 16 files. New `tests/working-directory.test.ts` covers storage, claim, default root, invalid values, legacy fallback, missing-directory failure, reopen persistence, abort/retry, and concurrent different directories. Seam B covers offline `tq add` from a nested directory followed by daemon pickup. Seam C covers HTTP default/explicit/invalid cwd.
