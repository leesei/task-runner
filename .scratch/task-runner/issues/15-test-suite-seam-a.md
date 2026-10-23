# 15: Test suite — core operations seam (Seam A)

**What to build:** The primary test suite using Bun's built-in test runner. Tests call core functions directly in-process with an isolated environment (temp data directory, temp project task folder, fixture task packages, explicit runner ticks). No HTTP server is started. Covers: task discovery and namespaces, manifest and schema validation, queue creation, autostart, FIFO draining, concurrency limits, stop/start/abort, exit-code mapping, log capture, log reads, persistence, crash recovery, and consumption of abort/reload control requests. HTTP adapter behavior belongs to Seam C.

Fixture tasks needed at this seam: a success task, an explicit-failure task, a throwing task, a slow task that honors the abort signal, a noisy task writing to both streams, an echo task that prints its input, a task with no schema, and a task whose manifest is invalid or conflicting. The slow task is what makes concurrency and stop/abort deterministic.

**Blocked by:** 11

**Status:** ready-for-agent

- [ ] Tests use Bun's built-in test runner
- [ ] Tests call core functions directly with isolated environment (temp data dir, temp task folder)
- [ ] No HTTP server is started in Seam A
- [ ] Fixture tasks available: success, explicit-failure, throwing, slow (honors abort signal), noisy (both streams), echo (prints input), no-schema, invalid manifest/conflicting
- [ ] Enqueue before daemon start, then start, observe autostart drain
- [ ] FIFO order within a queue
- [ ] Concurrency limit never exceeded, full utilization reached
- [ ] Stop lets RUNNING finish, leaves PENDING untouched, reports STOPPED
- [ ] Start resumes and drains remaining PENDING instances
- [ ] Abort control request is consumed on the next runner tick; instance returns to PENDING, partial output is preserved, queue stops, later start retries exactly once
- [ ] Immediate abort also stops the queue
- [ ] Enqueue into STOPPED queue stays PENDING; enqueue into IDLE queue starts
- [ ] Exit 0 → SUCCESS; non-zero and throw → FAILED; timeout → FAILED with `timeout`
- [ ] Stdout/stderr interleaving is preserved in log reads
- [ ] Schema violation returns `INPUT_SCHEMA_VIOLATION` with field issues and creates no instance
- [ ] Valid/invalid contexts are covered for required, type, enum, min/max, and schema-less tasks
- [ ] Malformed JSON and unknown id are rejected without creating an instance
- [ ] Bare-string wrapping only applies to single-required-string schema case
- [ ] Clear removes SUCCESS rows and log files; clear --all refuses while RUNNING
- [ ] Restart resets RUNNING to PENDING, preserves STOPPED queues, keeps finished instances
- [ ] Reload picks up new task folder and changed concurrency, reports conflicts
- [ ] Tests assert on observable behavior (log content, instance states), not internal tables or SQL
- [ ] `mediainfo` unavailable → skip minfo success case; keep failure-path test unconditional
