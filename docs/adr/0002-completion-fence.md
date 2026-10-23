# ADR-0002: Fence completions with the claimed attempt

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** `docs/adr/0001-task-lifecycle-ownership.md`, `docs/SPECS.md` D5–D8

## Context

ADR-0001 gave the lifecycle `finishRun(instanceId, outcome)` and relied on the
instance's persisted state to reject late completions. That is not enough.

An abort moves a `RUNNING` instance back to `PENDING` and increments its
attempt. The runner may then claim it again, moving it to `RUNNING` at the new
attempt. If the old execution ignores its `AbortSignal` and later calls
`done()`, the persisted state is `RUNNING` again, so a state-only check accepts
the stale result and overwrites the new attempt.

The same problem exists for controllers keyed by instance id: an abort result
for attempt 1 can signal a controller that already belongs to attempt 2.

## Decision

The claim carries the attempt and acts as the completion fence.

```ts
interface ClaimToken {
  instanceId: number;
  attempt: number;
}

finishRun(token: ClaimToken, outcome: RunOutcome): FinishResult;
```

- `claim` does not increment the attempt. The claimed row's attempt is the
  execution's attempt.
- `abortQueue` and `recoverOnBoot` increment the attempt when they return a
  `RUNNING` instance to `PENDING`.
- `finishRun` applies only when the row is `RUNNING` and its attempt equals
  `token.attempt`, in the same transaction.
- A non-running or unknown instance returns
  `{ applied: false, ignored: "not-running" }`. An attempt mismatch returns
  `{ applied: false, ignored: "stale-attempt" }`. Neither writes a row or
  publishes an event.
- The runner keys controllers by `instanceId:attempt`. `abortQueue` returns the
  attempts that were running before it incremented them, so a stale abort
  token cannot signal a newer execution. It also accepts the control request's
  recorded tokens and discards the request when none still matches a `RUNNING`
  instance.

The attempt is both the human-visible retry count and the fence token. Every
path that abandons a running attempt must increment it; every path that
completes an attempt must present the token it was given.

## Consequences

### Positive

- A task that ignores its abort signal cannot corrupt a retry.
- Stale abort requests and stale controller entries become harmless.
- Completion is total for the runner: aborted, timed-out, recovered, and
  cleared instances are no-ops rather than error branches.
- Tests can exercise the race by finishing with an old token after a re-claim.

### Negative

- `attempt` has two jobs: display count and fence token. A dedicated
  `run_token` column would separate them, but it adds schema churn for no
  behavioural gain while every abandon path already increments the count.
- Callers must carry the token from claim to completion. That is deliberate:
  the token is the interface, not an optional check.
- A completion for an unknown instance is silent. The runner should log
  `applied: false` at debug level rather than throw.

## Alternatives considered

- **Check state only.** Rejected: re-claim makes the state `RUNNING` again, so
  the stale completion wins.
- **Add a separate run token column.** Rejected for now: the attempt already
  increments on every abandon path, and adding a second counter doubles the
  paths that can drift. Revisit if attempt needs to remain a pure retry count.
- **Let the runner remember a local "finished" flag.** Rejected: it fences only
  one process and one execution, not recovery, abort, or a second runner.
- **Throw `INSTANCE_NOT_FOUND` for a stale completion.** Rejected: late
  completion is expected under cooperative cancellation and must not turn the
  runner's completion path into error handling.
