# 09: CLI commands — add, start, stop, abort, clear, status, logs, reload

**What to build:** The `tq` CLI: `add <task> [context]`, `start <queue>`, `stop <queue>`, `abort <queue>`, `clear [--all] <queue>`, `status`, `logs <instance-id>`, `reload`. The CLI calls the shared core functions in-process; it never calls the daemon HTTP API, probes `/api/health`, or depends on the daemon port. Offline-capable commands (`add`, `status`, `logs`, `clear`) open SQLite directly and work with the daemon stopped. `start`/`stop` call core lifecycle operations. `abort`/`reload` write durable control requests that the daemon runner consumes on its poll tick. Control commands require a live daemon, detected from `daemon.json` plus a pid liveness check. `add` accepts escaped JSON, `@file`, and `name=value` / `name:=value` contexts, resolves schema path fields relative to the invocation directory, validates through core, and prints the instance id, creation time, task id, and normalized context. `-v`/`--verbose` writes resolution diagnostics to stderr. `status` prints one line per queue with state, concurrency, running, and pending counts. `logs <instance-id>` prints the merged log. Exit codes: 0 success; 1 runtime failure; 2 usage, unknown task, malformed input, or schema violation.

**Blocked by:** 13, 18

**Status:** done

**Evidence:** Updated CLI in src/cli/index.ts, args.ts, commands/add.ts to match spec (add prints instance id/time/task/context; global -v/--verbose with stderr diagnostics; all commands accept --data-dir; offline commands use core in-process; live control commands require daemon via daemon.json pid check with process.kill(pid,0), no HTTP probe; exit codes 0/1/2). Merged feat/task-runner-integration. All tests pass (112 pass, 0 fail).

- [x] `tq add <task> [context]`: parses all context sources, resolves path fields, calls core validation/enqueue, prints id + time + task + context
- [x] `tq add` supports escaped JSON, `@file`, `name=value`, and `name:=value`
- [x] `tq add` rejects schema violations with field issues and exit code 2
- [x] Relative `format: "path"` values resolve against the invocation directory; absolute values are kept
- [x] `-v`/`--verbose` is global and repeatable; diagnostics go to stderr
- [x] `tq start <queue>`: calls core to begin draining pending instances
- [x] `tq stop <queue>`: calls core to finish running instances, start nothing new
- [x] `tq abort <queue>`: writes an abort control request; runner returns instances to PENDING, leaves queue stopped
- [x] `tq clear [--all] <queue>`: calls core to delete SUCCESS instances (or all finished) and their logs
- [x] `tq status`: calls core to read queues; prints state, concurrency, running, pending counts
- [x] `tq logs <instance-id>`: calls core to read and print merged stdout/stderr log
- [x] `tq reload`: calls core discovery, writes a reload request, waits for runner consumption
- [x] CLI imports and calls core operations in-process
- [x] CLI never calls `fetch`/`Bun.fetch`, `/api/*`, or `/api/health`
- [x] CLI does not use the daemon port for command behavior
- [x] Offline commands (`add`, `status`, `logs`, `clear`) work with the daemon stopped
- [x] Live control commands (`start`, `stop`, `abort`, `reload`) fail clearly without a live daemon
- [x] Daemon liveness uses `daemon.json` pid + `process.kill(pid, 0)`, not an HTTP probe
- [x] Exit code 0: success; 1: runtime failure; 2: usage/unknown task/malformed input/schema violation
- [x] `--data-dir` flag accepted by all commands so offline commands find the same database
