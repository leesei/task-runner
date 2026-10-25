# 16: Test suite — CLI subprocess seam (Seam B)

**What to build:** Secondary test suite that spawns the real `tq` binary against an isolated environment. Covers only CLI-shaped behavior: argument parsing, help output, exit codes (0/1/2), `add` → id output, `status` and `logs` formatting, unknown-task and invalid-input errors, `add` with no daemon followed by daemon pickup, control commands failing clearly with no daemon, control requests reaching a live daemon, and `clear --all` refusal. Include a no-HTTP guard: run with a descriptor pointing at an unused port (or the API disabled) and verify commands still work. Everything else belongs at Seam A; do not duplicate the queue-state suite through the CLI.

**Blocked by:** 15

**Status:** done

- [x] Spawns real `tq` binary against isolated environment
- [x] Argument parsing: `tq --help` prints usage; `tq daemon --help` prints daemon flags
- [x] Exit codes: 0 success, 1 runtime failure, 2 usage/unknown task/malformed input/schema violation
- [x] `tq add <task> <context>` prints instance id, creation time, task id, and normalized context
- [x] `tq add` supports escaped JSON, `@file`, `name=value`, and `name:=value`
- [x] Relative path fields resolve against the invocation directory; absolute paths are unchanged
- [x] `-v`/`--verbose` writes diagnostics to stderr without changing stdout output
- [x] Schema violations print field issues and exit 2
- [x] `tq status` prints one line per queue with state, concurrency, running, pending
- [x] `tq logs <instance-id>` prints merged log
- [x] Unknown task id → clear error, exit code 2
- [x] Invalid input (malformed JSON, schema violation) → clear error, exit code 2
- [x] `tq add` with no daemon → enqueues to SQLite; daemon picks up when started
- [x] Control commands (`start`, `stop`, `abort`, `reload`) fail clearly with no daemon running
- [x] Control commands reach a live daemon through core + control requests, not HTTP
- [x] CLI works when the descriptor port is unreachable or the HTTP API is disabled
- [x] `tq clear --all <queue>` refuses when instance is RUNNING
- [x] Does not duplicate the queue-state suite from Seam A

## Comments

Implemented in `tests/cli-seam-b.test.ts` with 16 subprocess tests. The suite rebuilds `bin/tq` in `beforeAll` so it never tests a stale ignored artifact. It covers help, exit codes 0/1/2, all `add` context sources, path resolution, `-v`, validation failures, status/log formatting, offline enqueue followed by live daemon pickup, live abort through a durable control request, clear refusal while RUNNING, and the no-HTTP guard. The CLI also now reloads discovery for offline `add` when a task is not registered, and boolean flags (`--all`, `--tasks`) no longer consume the following queue/positional argument.

Verification: `bun test tests/cli-seam-b.test.ts` → 16 pass, 0 fail; full `bun test` → 135 pass, 0 fail; `bun run tests/run-all.ts` → 13/13; `bun run build` succeeds.
