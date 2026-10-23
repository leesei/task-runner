# ADR-0001: One owner for the task lifecycle

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** `docs/SPECS.md` D5–D11, `GLOSSARY.md`
- **Amended by:** ADR-0002 (completion carries the claim token)

## Context

Task instance and queue state is written from four places:

- `runner/runner.ts` moves instances to `PENDING` during abort and marks them `RUNNING` before launch;
- `runner/execution.ts` marks `SUCCESS`/`FAILED` and increments attempts;
- `runner/queue-state.ts` owns the queue transitions, but `enqueue`, autostart, and drain write queue state directly;
- `control/queue-control.ts` contains a second abort implementation that is no longer called.

Two abort implementations are dead (`controlAbort`, `abortInstance`). The concurrency limit is enforced by a read-then-write sequence in the runner, outside any transaction. The HTTP adapter imports database rows for reads, and the runner imports the HTTP adapter's event emitter, so the dependency between core behaviour and a transport adapter runs in the wrong direction.

The result is a shallow lifecycle: its interface is a set of row-level updates, its callers do not use it consistently, and its invariants live at call sites.

## Decision

### 1. One module owns instance and queue transitions

`src/core/lifecycle.ts` owns both state machines. The queue and instance machines are coupled at abort (instance returns to `PENDING` _and_ the queue becomes `STOPPED`) and at enqueue (an instance is created _and_ an `IDLE` queue moves to `PROCESSING`), so splitting them would recreate the current spread.

The module is transport-independent. It does not import the CLI, the HTTP adapter, or the runner.

### 2. Persisted state only

The lifecycle owns states, attempts, timestamps, queue concurrency, `log_path`, and the events that describe those changes. It does not own:

- the `AbortController` registry;
- task module import, timeout enforcement, or console interception;
- polling and consuming control requests.

Those stay in `runner/runner.ts` and `runner/execution.ts`. `abortQueue` returns the claim tokens the runner must signal; the runner fires the controllers.

### 3. Intent-level interface

```ts
createLifecycle({ db, events, logDir }): Lifecycle

enqueue(taskId, input): { id, createdAt }
claimQueue(queueId): Claim[]
finishRun(instanceId, outcome): { applied, state?, queueState? }
abortQueue(queueId): { instanceIds, queueState }
start(queueId): QueueState
stop(queueId): QueueState
syncQueues(): { created, updated }
recoverOnBoot(): { reset, started, stayedStopped }
```

> ADR-0002 amends this interface: a claim carries `{ instanceId, attempt }`,
> `finishRun` takes that token, and `abortQueue` returns the attempts that were
> running before it incremented them. The lifecycle also exposes `claim()` as a
> batched form of `claimQueue`.

A `Claim` is `{ instanceId, attempt, taskId, entryPoint, timeoutMs, input, logPath }`. `claimQueue` enforces FIFO order and the queue concurrency limit inside one transaction and moves the claimed instances to `RUNNING`. Callers never perform a read-then-write to decide what may run.

`finishRun` auto-drains a `PROCESSING` queue to `IDLE` when the last running instance finishes, in the same transaction. Late completion after an abort or timeout returns `{ applied: false }`; it is expected under cooperative cancellation and is not an error.

`abortQueue` recomputes the currently `RUNNING` instances rather than trusting tokens captured when a control request was written. It returns them to `PENDING`, increments their attempts, stops the queue, and returns the claim tokens the runner must signal.

`syncQueues` ensures one queue per task and updates concurrency for existing queues. Deleting queues for removed tasks is deliberately deferred; it needs a decision about retaining historical instances.

`recoverOnBoot` resets `RUNNING` instances to `PENDING`, increments their attempts, keeps `STOPPED` queues stopped, and starts every other queue.

`enqueue` trusts its input. Input validation and CLI context parsing remain a separate module (see `docs/SPECS.md` D4 and the input-validation ticket); keeping it out of the lifecycle avoids coupling the two changes.

### 4. One transaction per operation

Every operation that writes more than one row uses one SQLite transaction. Events publish after the transaction commits, so subscribers never observe uncommitted state.

### 5. Events are published through an injected sink

`src/core/events.ts` defines the event types, `EventSink`, and `createEventBus()`. The daemon creates one bus and injects it into the lifecycle and the HTTP adapter.

The lifecycle publishes after commit: instance event first, queue event second. The payload carries the new state only (`queueId`/`instanceId` + state). The bus isolates subscriber exceptions so a bad listener cannot fail a transition.

The lifecycle never imports `src/api`. The HTTP adapter subscribes to the bus for SSE. Tests pass a recording sink.

### 6. Stable errors, not prose

`CoreError` moves to `src/core/errors.ts` and keeps a stable `code`. Lifecycle operations throw it for `QUEUE_NOT_FOUND`, `INSTANCE_NOT_FOUND`, `INVALID_TRANSITION`, and `CLEAR_REFUSED_RUNNING`.

Adapters map codes to HTTP status or CLI exit code. They do not inspect error messages, and `ControlResult` disappears.

### 7. Core is a factory over the lifecycle

`src/core/service.ts` becomes `createCore({ db, lifecycle })`. The lifecycle is private to core; adapters call core operations only. `createApi({ core, events, dataDir, cwd })` and the CLI commands construct a core over their database.

The API and CLI no longer import `db/queries`; reads (`getQueue`, `listInstances`, `getInstance`, `readLog`, `getTaskDefinitions`) are core operations.

Control-request reads remain the one documented direct `db/queries` use in the runner: they are a durable command channel, not task or queue state.

### 8. Logs append across attempts

The claim computes `instance-<id>.jsonl` and persists `log_path` in the same transaction that marks the instance `RUNNING`. Execution ensures the file exists and appends; it never truncates at claim. A retry preserves the aborted or crashed attempt's output, matching the append-only log rule in `docs/SPECS.md` D8.

## Consequences

### Positive

- State invariants concentrate in one module; fixing a transition fixes every caller.
- Concurrency and FIFO are atomic and testable without the runner loop.
- The runner and lifecycle no longer depend on the HTTP adapter.
- Every transition path publishes events, including CLI-driven commands and boot recovery.
- Adapters become mappers: parse input, call core, map codes, format output.
- The lifecycle interface is the primary test surface.

### Negative

- `createCore` adds construction noise to CLI commands until the project-handle refactor lands.
- Queue retirement remains outstanding, so reload still leaves orphan queues.
- Moving reads into core adds operations that are mostly pass-through; they earn their place by removing adapter-level database access, not by depth.

## Alternatives considered

- **Two lifecycle modules (queue and instance).** Rejected: the coupling at abort and enqueue is the invariant; callers would reassemble it.
- **Publish events from adapters.** Rejected: only HTTP-driven transitions would emit, which is the current bug.
- **Keep `ControlResult` and add codes to it.** Rejected: two error styles force every adapter to handle both; one thrown type maps once.
- **Keep lifecycle in `src/runner/`.** Rejected: `core` and `control` already call it; the runner is one caller, not the owner.
- **Claim by selecting rows in the runner.** Rejected: it preserves the check-then-write gap and puts the concurrency rule outside the state owner.

## Deferred

- **Project handle:** one `openProject` interface for data-directory resolution, database bootstrap, descriptor read/write, and daemon liveness.
- **Task registry:** split pure discovery from a reconciling registry that can retire removed tasks and their queues.
- **Dashboard:** read-only, live view over the event bus.
- **Descriptor reads in the HTTP adapter:** health currently reads `daemon.json` directly; fold into the project handle.
