# 16: Test suite — CLI subprocess seam (Seam B)

**What to build:** Secondary test suite that spawns the real `tq` binary against an isolated environment. Covers only CLI-shaped behavior: argument parsing, help output, exit codes (0/1/2), `add` → id output, `status` and `logs` formatting, unknown-task and invalid-input errors, `add` with no daemon followed by daemon pickup, control commands failing clearly with no daemon, and `clear --all` refusal. Everything else belongs at Seam A; do not duplicate the queue-state suite through the CLI.

**Blocked by:** 15

**Status:** ready-for-agent

- [ ] Spawns real `tq` binary against isolated environment
- [ ] Argument parsing: `tq --help` prints usage; `tq daemon --help` prints daemon flags
- [ ] Exit codes: 0 success, 1 runtime failure, 2 usage/unknown task/malformed input/schema violation
- [ ] `tq add <task> <context>` prints the new instance id
- [ ] `tq status` prints one line per queue with state, concurrency, running, pending
- [ ] `tq logs <instance-id>` prints merged log
- [ ] Unknown task id → clear error, exit code 2
- [ ] Invalid input (malformed JSON, schema violation) → clear error, exit code 2
- [ ] `tq add` with no daemon → enqueues to SQLite; daemon picks up when started
- [ ] Control commands (`start`, `stop`, `abort`, `reload`) fail clearly with no daemon running
- [ ] `tq clear --all <queue>` refuses when instance is RUNNING
- [ ] Does not duplicate the queue-state suite from Seam A
