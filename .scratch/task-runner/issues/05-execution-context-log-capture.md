# 05: Execution context, console interception, and log capture

**What to build:** The execution contract: the runner calls a task's default export with `{ input, signal, done }`, awaits it, and maps completion to instance state. A single `console.log`/`console.error` interception is installed at daemon start; each execution runs inside an `AsyncLocalStorage` scope tagged with the active instance id, so concurrent instances write to the correct log. Logs are append-only JSONL files (one per instance) with records carrying timestamp, stream (`stdout`/`stderr`), and text. Cancellation is cooperative: abort fires the instance's `AbortSignal`; the runner waits a 5-second grace period then releases the slot and returns the instance to PENDING regardless. Late output from superseded attempts is discarded.

**Blocked by:** 04

**Status:** in-progress

- [ ] ExecutionContext shape: `{ input: TInput, signal: AbortSignal, done: (exitCode: number) => void }`
- [ ] Runner calls task's default export, awaits it; completion without `done` → exit code 0
- [ ] `done(0)` → SUCCESS; `done(nonZero)` or throw → FAILED
- [ ] First terminal signal wins; second `done` or throw after completion → ignored, recorded as warning
- [ ] Single `console.log`/`console.error` interception installed at daemon start
- [ ] Each execution runs in an `AsyncLocalStorage` scope tagged with active instance id
- [ ] Concurrent instances write to the correct log file
- [ ] Log files are append-only JSONL: one file per instance in the logs directory
- [ ] Each log record: `{ timestamp, stream: "stdout"|"stderr", text }`
- [ ] Abort fires the instance's AbortSignal; runner waits 5-second grace period
- [ ] After grace period, slot released, instance returned to PENDING regardless of task state
- [ ] Late output and late state writes from superseded attempt are discarded (fenced by instance id)
