# 15: Test suite — core operations seam (Seam A)

**What to build:** The primary test suite using Bun's built-in test runner. Tests call core functions directly in-process with an isolated environment (temp data directory, temp project task folder, fixture task packages, explicit runner ticks). No HTTP server is started. Covers: task discovery and namespaces, manifest and schema validation, queue creation, autostart, FIFO draining, concurrency limits, stop/start/abort, exit-code mapping, log capture, log reads, persistence, crash recovery, and consumption of abort/reload control requests. HTTP adapter behavior belongs to Seam C.

Fixture tasks needed at this seam: a success task, an explicit-failure task, a throwing task, a slow task that honors the abort signal, a noisy task writing to both streams, an echo task that prints its input, a task with no schema, and a task whose manifest is invalid or conflicting. The slow task is what makes concurrency and stop/abort deterministic.

**Blocked by:** 09, 11, 12, 13, 14, 18

**Status:** done

- [x] Tests use Bun's built-in test runner
- [x] Tests call core functions directly with isolated environment (temp data dir, temp task folder)
- [x] No HTTP server is started in Seam A
- [x] Fixture tasks available: success, explicit-failure, throwing, slow (honors abort signal), noisy (both streams), echo (prints input), no-schema, invalid manifest/conflicting
- [x] Enqueue before daemon start, then start, observe autostart drain
- [x] FIFO order within a queue
- [x] Concurrency limit never exceeded, full utilization reached
- [x] Stop lets RUNNING finish, leaves PENDING untouched, reports STOPPED
- [x] Start resumes and drains remaining PENDING instances
- [x] Abort control request is consumed on the next runner tick; instance returns to PENDING, partial output is preserved, queue stops, later start retries exactly once
- [x] Immediate abort also stops the queue
- [x] Enqueue into STOPPED queue stays PENDING; enqueue into IDLE queue starts
- [x] Exit 0 → SUCCESS; non-zero and throw → FAILED; timeout → FAILED with `timeout`
- [x] Stdout/stderr interleaving is preserved in log reads
- [x] Schema violation returns `INPUT_SCHEMA_VIOLATION` with field issues and creates no instance
- [x] Valid/invalid contexts are covered for required, type, enum, min/max, and schema-less tasks
- [x] Malformed JSON and unknown id are rejected without creating an instance
- [x] Bare-string wrapping only applies to single-required-string schema case
- [x] Clear removes SUCCESS rows and log files; clear --all refuses while RUNNING
- [x] Restart resets RUNNING to PENDING, preserves STOPPED queues, keeps finished instances
- [x] Reload picks up new task folder and changed concurrency, reports conflicts
- [x] Tests assert on observable behavior (log content, instance states), not internal tables or SQL
- [x] `mediainfo` unavailable → skip minfo success case; keep failure-path test unconditional

**Evidence:** Added tests/core-seam-a.test.ts (13 passing tests) covering core API directly with temp dirs, fixtures for all required task types, runner ticks for drain/abort, schema validation errors, timeout/fail/throw cases, log capture, clear semantics, recovery/reload. Merged integration branch feat/task-runner-integration.
