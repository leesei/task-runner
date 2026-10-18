# 09: CLI commands — add, start, stop, abort, clear, status, logs, reload

**What to build:** The `tq` CLI: `add <task> [context]`, `start <queue>`, `stop <queue>`, `abort <queue>`, `clear [--all] <queue>`, `status`, `logs <instance-id>`, `reload`. CLI discovers the daemon via the descriptor file + health probe. When reachable, mutations go through the HTTP API. When not reachable, `add`, `status`, `logs`, and `clear` operate directly on SQLite. Control commands fail clearly when the daemon is not running. `add` prints the new instance id. `status` prints one line per queue with state, concurrency, running, and pending counts. `logs <instance-id>` prints the merged log. Exit codes: 0 success; 1 runtime failure; 2 usage, unknown task, malformed input, or schema violation.

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] `tq add <task> [context]`: validates input, enqueues instance, prints new instance id
- [ ] `tq start <queue>`: begins draining pending instances
- [ ] `tq stop <queue>`: finishes running instances, starts nothing new
- [ ] `tq abort <queue>`: cancels running instances back to PENDING, leaves queue stopped
- [ ] `tq clear [--all] <queue>`: deletes SUCCESS instances (or all finished) and their logs
- [ ] `tq status`: prints one line per queue with state, concurrency, running, pending counts
- [ ] `tq logs <instance-id>`: prints merged stdout/stderr log
- [ ] `tq reload`: re-reads task definitions and applies changes
- [ ] CLI discovers daemon via descriptor file + health probe
- [ ] When daemon reachable: mutations go through HTTP API
- [ ] When daemon not reachable: `add`, `status`, `logs`, `clear` operate directly on SQLite
- [ ] Control commands (`start`, `stop`, `abort`, `reload`) fail clearly when daemon not running
- [ ] `add` prints the new instance id to stdout
- [ ] Exit code 0: success; 1: runtime failure; 2: usage/unknown task/malformed input/schema violation
- [ ] `--data-dir` flag accepted by all commands so offline commands find the same database
