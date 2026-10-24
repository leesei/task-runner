# Glossary

Terms used across the task runner. See `docs/SPECS.md` for the full specification.

## Task

A self-describing definition discovered from a search path: a folder with an entrypoint, `README.md`, `settings.json`, and an optional input schema. Identified as `namespace:id`.

## Task instance

One enqueued execution of a task. Carries normalized input, attempt number, state (`PENDING`, `RUNNING`, `SUCCESS`, `FAILED`), timings, exit code, failure reason, and log path. Referred to by its numeric id. The attempt number is also the completion fence: a finish applies only to the running attempt it was claimed from.

## Queue

The single FIFO lane for a task definition. The queue id equals the task id. State is `IDLE`, `PROCESSING`, or `STOPPED`; concurrency caps how many instances may be `RUNNING`.

## Task lifecycle

The rules that move task instances and their queues between states: enqueue, claim, finish, abort, drain, start, stop, and boot recovery. One module owns these transitions and their invariants; adapters do not write state.

## Queue lifecycle

The queue-state half of the task lifecycle: `IDLE` ⇄ `PROCESSING`, `IDLE`/`PROCESSING` → `STOPPED`, `STOPPED` → `PROCESSING` or `IDLE`, and automatic drain when the last running instance finishes.

## Intent operation

A command that names the desired queue state rather than a specific edge: `start` targets `PROCESSING` when there is work and `IDLE` when there is none; `stop` targets `STOPPED`. Repeating an intent in its target state is a no-op, not an error.

## Claim

A runnable task instance handed from the lifecycle to the runner: instance id, attempt, task id, entrypoint, timeout, parsed input, and log path. A claim means the instance has already moved to `RUNNING` inside the lifecycle transaction.

## Claim token

The pair `{ instanceId, attempt }` used to fence a completion. `finishRun` applies only when the token matches a `RUNNING` instance at that attempt; a stale token is a no-op. The runner also keys its `AbortController`s by this pair.

## Event sink

The injected interface the lifecycle uses to publish queue and instance state changes after a transaction commits. The daemon supplies an event bus; tests supply a recorder. The lifecycle never imports an adapter.

## Event bus

The daemon-owned implementation behind an event sink that fans events out to subscribers such as the HTTP SSE adapter.
