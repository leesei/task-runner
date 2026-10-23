# 16: Test suite — CLI subprocess seam (Seam B)

**What to build:** Secondary test suite that spawns the real `tq` binary against an isolated environment. Covers only CLI-shaped behavior: argument parsing, help output, exit codes (0/1/2), `add` → id output, `status` and `logs` formatting, unknown-task and invalid-input errors, `add` with no daemon followed by daemon pickup, control commands failing clearly with no daemon, control requests reaching a live daemon, and `clear --all` refusal. Include a no-HTTP guard: run with a descriptor pointing at an unused port (or the API disabled) and verify commands still work. Everything else belongs at Seam A; do not duplicate the queue-state suite through the CLI.

**Blocked by:** 15

**Status:** ready-for-agent

- [ ] Spawns real `tq` binary against isolated environment
- [ ] Argument parsing: `tq --help` prints usage; `tq daemon --help` prints daemon flags
- [ ] Exit codes: 0 success, 1 runtime failure, 2 usage/unknown task/malformed input/schema violation
- [ ] `tq add <task> <context>` prints instance id, creation time, task id, and normalized context
- [ ] `tq add` supports escaped JSON, `@file`, `name=value`, and `name:=value`
- [ ] Relative path fields resolve against the invocation directory; absolute paths are unchanged
- [ ] `-v`/`--verbose` writes diagnostics to stderr without changing stdout output
- [ ] Schema violations print field issues and exit 2
- [ ] `tq status` prints one line per queue with state, concurrency, running, pending
- [ ] `tq logs <instance-id>` prints merged log
- [ ] Unknown task id → clear error, exit code 2
- [ ] Invalid input (malformed JSON, schema violation) → clear error, exit code 2
- [ ] `tq add` with no daemon → enqueues to SQLite; daemon picks up when started
- [ ] Control commands (`start`, `stop`, `abort`, `reload`) fail clearly with no daemon running
- [ ] Control commands reach a live daemon through core + control requests, not HTTP
- [ ] CLI works when the descriptor port is unreachable or the HTTP API is disabled
- [ ] `tq clear --all <queue>` refuses when instance is RUNNING
- [ ] Does not duplicate the queue-state suite from Seam A
