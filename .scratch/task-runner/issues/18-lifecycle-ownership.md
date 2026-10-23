# 18: Lifecycle ownership, atomic claims, completion fence, and events

**What to build:** Extract the queue/instance state owner described by `docs/DESIGN.md`, ADR-0001, and ADR-0002. The lifecycle module is the only writer of queue and instance state; adapters (CLI, HTTP, runner) call intent-level core operations instead of writing state or importing `db/queries`. Every intent runs in one immediate SQLite transaction. Claims are atomic and return a `ClaimToken { instanceId, attempt }`; completion and abort are fenced by that token so a stale attempt cannot finish or abort a newer one. The runner claims work and consumes control requests; execution owns imports, timeout, logging, and task code. Events are published through an injected sink after commit, with instance events before queue events.

**Blocked by:** 13

**Status:** ready-for-agent

- [ ] `src/core/lifecycle.ts` owns queue/instance writes: `enqueue`, `claim`, `claimQueue`, `finishRun`, `abortQueue`, `start`, `stop`, `syncQueues`, `recoverOnBoot`, `clearQueue`
- [ ] `claim()` is the batched runner call and `claimQueue(queueId)` is the per-queue primitive; both share `claimFromQueue`
- [ ] Every lifecycle intent uses one immediate SQLite transaction; no read-then-write state races
- [ ] Claim atomically selects PENDING work, increments `attempt`, marks RUNNING, and persists `log_path`
- [ ] `ClaimToken { instanceId, attempt }` is returned by claims and accepted by `finishRun` / `abortQueue`
- [ ] Completion is fenced: a token from an older attempt is a no-op; controllers are keyed by `instanceId:attempt`
- [ ] Abort control requests persist claim tokens; stale tokens are discarded; abort returns the instance to PENDING, preserves partial output, leaves the queue STOPPED, and allows exactly one retry on the next start
- [ ] Abort gives a running task a 5-second grace period before forcibly stopping it
- [ ] Logs append across attempts; a retry never truncates earlier output
- [ ] `start` and `stop` are idempotent intent operations; `IDLE -> STOPPED` is allowed
- [ ] `syncQueues` creates queues and updates concurrency on reload without retiring queues that still exist
- [ ] `recoverOnBoot` resets RUNNING instances to PENDING and increments `attempt`
- [ ] `clearQueue` deletes eligible instances and returns the log paths to delete; lifecycle does not touch the filesystem
- [ ] `src/core/events.ts` defines an injected `EventSink`; events are published after commit, instance events before queue events
- [ ] Events cover enqueue, claim/RUNNING, finish, queue drain, autostart, clear, start/stop, and abort
- [ ] `src/core/errors.ts` holds core error types, including `INPUT_SCHEMA_VIOLATION`
- [ ] `createCore({ db, lifecycle, events, ... })` is the adapter-facing factory; CLI/HTTP/runner do not import `db/queries` for state
- [ ] Runner only consumes control requests and claims; execution owns task imports, timeout, and log capture
- [ ] `src/runner/execution.ts` no longer imports the API event emitter
- [ ] Reload re-imports edited task code with cache busting and applies concurrency changes
- [ ] Targeted tests cover atomic claim, stale completion/abort, attempt increments, log append, idempotent start/stop, and event order
