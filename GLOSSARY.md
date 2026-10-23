# Glossary

Terms used across the task runner. See `docs/SPECS.md` for the full specification.

## Task

A self-describing definition discovered from a search path: a folder with an entrypoint, `README.md`, `settings.json`, and an optional input schema. Identified as `namespace:id`.

## Task instance

One enqueued execution of a task. Carries normalized input, attempt number, state (`PENDING`, `RUNNING`, `SUCCESS`, `FAILED`), timings, exit code, failure reason, and log path. Referred to by its numeric id.

## Queue

The single FIFO lane for a task definition. The queue id equals the task id. State is `IDLE`, `PROCESSING`, or `STOPPED`; concurrency caps how many instances may be `RUNNING`.

## Task lifecycle

The rules that move task instances and their queues between states: enqueue, claim, finish, abort, drain, start, stop, and boot recovery. One module owns these transitions and their invariants; adapters do not write state.

## Queue lifecycle

The queue-state half of the task lifecycle: `IDLE` ⇄ `PROCESSING`, `PROCESSING` → `STOPPED`, `STOPPED` → `PROCESSING`, and automatic drain when the last running instance finishes.

## Claim

A runnable task instance handed from the lifecycle to the runner: instance id, task id, entrypoint, timeout, parsed input, and log path. A claim means the instance has already moved to `RUNNING` inside the lifecycle transaction.

## Event sink

The injected interface the lifecycle uses to publish queue and instance state changes after a transaction commits. The daemon supplies an event bus; tests supply a recorder. The lifecycle never imports an adapter.

## Event bus

The daemon-owned implementation behind an event sink that fans events out to subscribers such as the HTTP SSE adapter.
