# 18: Lifecycle ownership, atomic claims, completion fence, and events

**What to build:** Extract the queue/instance state owner described by `docs/DESIGN.md`, ADR-0001, and ADR-0002. The lifecycle module is the only writer of queue and instance state; adapters (CLI, HTTP, runner) call intent-level core operations instead of writing state or importing `db/queries`. Every intent runs in one immediate SQLite transaction. Claims are atomic and return a `ClaimToken { instanceId, attempt }`; completion and abort are fenced by that token so a stale attempt cannot finish or abort a newer one. The runner claims work and consumes control requests; execution owns imports, timeout, logging, and task code. Events are published through an injected sink after commit, with instance events before queue events.

**Blocked by:** 13

**Status:** done

- [x] `src/core/lifecycle.ts` owns queue/instance writes: `enqueue`, `claim`, `claimQueue`, `finishRun`, `abortQueue`, `start`, `stop`, `syncQueues`, `recoverOnBoot`, `clearQueue`
- [x] `claim()` is the batched runner call and `claimQueue(queueId)` is the per-queue primitive; both share `claimFromQueue`
- [x] Every lifecycle intent uses one immediate SQLite transaction; no read-then-write state races
- [x] Claim atomically selects PENDING work, increments `attempt`, marks RUNNING, and persists `log_path`
- [x] `ClaimToken { instanceId, attempt }` is returned by claims and accepted by `finishRun` / `abortQueue`
- [x] Completion is fenced: a token from an older attempt is a no-op; controllers are keyed by `instanceId:attempt`
- [x] Abort control requests persist claim tokens; stale tokens are discarded; abort returns the instance to PENDING, preserves partial output, leaves the queue STOPPED, and allows exactly one retry on the next start
- [x] Abort gives a running task a 5-second grace period before forcibly stopping it
- [x] Logs append across attempts; a retry never truncates earlier output
- [x] `start` and `stop` are idempotent intent operations; `IDLE -> STOPPED` is allowed
- [x] `syncQueues` creates queues and updates concurrency on reload without retiring queues that still exist
- [x] `recoverOnBoot` resets RUNNING instances to PENDING and increments `attempt`
- [x] `clearQueue` deletes eligible instances and returns the log paths to delete; lifecycle does not touch the filesystem
- [x] `src/core/events.ts` defines an injected `EventSink`; events are published after commit, instance events before queue events
- [x] Events cover enqueue, claim/RUNNING, finish, queue drain, autostart, clear, start/stop, and abort
- [x] `src/core/errors.ts` holds core error types, including `INPUT_SCHEMA_VIOLATION`
- [x] `createCore({ db, lifecycle, events, ... })` is the adapter-facing factory; CLI/HTTP/runner do not import `db/queries` for state
- [x] Runner only consumes control requests and claims; execution owns task imports, timeout, and log capture
- [x] `src/runner/execution.ts` no longer imports the API event emitter
- [x] Reload re-imports edited task code with cache busting and applies concurrency changes
- [x] Targeted tests cover atomic claim, stale completion/abort, attempt increments, log append, idempotent start/stop, and event order

## Comments

- Implemented on `ticket-18-lifecycle`; merged `feat/task-runner-spec` at `45feb5d` before starting and again before reporting.
- `src/core/lifecycle.ts` is the sole queue/instance writer; every intent is one `BEGIN IMMEDIATE` transaction via `db.transaction(fn).immediate()`. Events publish after commit, instance events before queue events; sink exceptions are isolated.
- The ticket's "claim increments `attempt`" line predates ADR-0002: claim keeps the attempt and acts as the fence token; only abort and recovery increment it.
- `finishRun` is fenced by `{instanceId, attempt}`; abort/recovery increment attempts and preserve `log_path`. Control requests now store `claim_tokens`; `openDatabase` migrates older databases with an additive `ALTER TABLE`.
- Runner consumes control requests and claims only; execution owns import (cache-busted), timeout (committed before signal), console capture, and append-only logs. Controllers are keyed `instanceId:attempt`.
- Legacy abort requests with only instance ids (attempt 0) are discarded as stale rather than allowed to abort a newer attempt.
- `clearQueue` publishes an `instancesCleared` event; the design's two state-change event types are unchanged.
- Tests: `bun test` — 112 pass, 0 fail. Build: `bun run build` succeeds. `bunx tsc --noEmit` has no `src/` errors (only pre-existing test-side `Response.json()` `unknown` narrowing in the HTTP smoke tests).
- Evidence: `tests/lifecycle.test.ts` (claim FIFO/concurrency, fence, abort tokens, attempts, recovery, idempotence, sync, clear, event order, migration) and `tests/runner-execution.test.ts` (append logs, timeout ordering, stale completion, abort grace, controller keys, reload/cache busting).
