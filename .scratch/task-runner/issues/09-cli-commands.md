# 09: CLI commands — add, start, stop, abort, clear, status, logs, reload

**What to build:** The `tq` CLI: `add <task> [context]`, `start <queue>`, `stop <queue>`, `abort <queue>`, `clear [--all] <queue>`, `status`, `logs <instance-id>`, `reload`. The CLI calls the shared core functions in-process; it never calls the daemon HTTP API, probes `/api/health`, or depends on the daemon port. Offline-capable commands (`add`, `status`, `logs`, `clear`) open SQLite directly and work with the daemon stopped. `start`/`stop` write queue state directly. `abort`/`reload` write durable control requests that the daemon runner consumes on its poll tick. Control commands require a live daemon, detected from `daemon.json` plus a pid liveness check. `add` accepts escaped JSON, `@file`, and `name=value` / `name:=value` contexts, resolves schema path fields relative to the invocation directory, validates through core, and prints the instance id, creation time, task id, and normalized context. `-v`/`--verbose` writes resolution diagnostics to stderr. `status` prints one line per queue with state, concurrency, running, and pending counts. `logs <instance-id>` prints the merged log. Exit codes: 0 success; 1 runtime failure; 2 usage, unknown task, malformed input, or schema violation.

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] `tq add <task> [context]`: parses all context sources, resolves path fields, calls core validation/enqueue, prints id + time + task + context
- [ ] `tq add` supports escaped JSON, `@file`, `name=value`, and `name:=value`
- [ ] `tq add` rejects schema violations with field issues and exit code 2
- [ ] Relative `format: "path"` values resolve against the invocation directory; absolute values are kept
- [ ] `-v`/`--verbose` is global and repeatable; diagnostics go to stderr
- [ ] `tq start <queue>`: calls core to begin draining pending instances
- [ ] `tq stop <queue>`: calls core to finish running instances, start nothing new
- [ ] `tq abort <queue>`: writes an abort control request; runner returns instances to PENDING, leaves queue stopped
- [ ] `tq clear [--all] <queue>`: calls core to delete SUCCESS instances (or all finished) and their logs
- [ ] `tq status`: calls core to read queues; prints state, concurrency, running, pending counts
- [ ] `tq logs <instance-id>`: calls core to read and print merged stdout/stderr log
- [ ] `tq reload`: calls core discovery, writes a reload request, waits for runner consumption
- [ ] CLI imports and calls core operations in-process
- [ ] CLI never calls `fetch`/`Bun.fetch`, `/api/*`, or `/api/health`
- [ ] CLI does not use the daemon port for command behavior
- [ ] Offline commands (`add`, `status`, `logs`, `clear`) work with the daemon stopped
- [ ] Live control commands (`start`, `stop`, `abort`, `reload`) fail clearly without a live daemon
- [ ] Daemon liveness uses `daemon.json` pid + `process.kill(pid, 0)`, not an HTTP probe
- [ ] Exit code 0: success; 1: runtime failure; 2: usage/unknown task/malformed input/schema violation
- [ ] `--data-dir` flag accepted by all commands so offline commands find the same database
