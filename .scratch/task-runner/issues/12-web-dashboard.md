# 12: Web dashboard (read-only, live update)

**What to build:** A read-only web dashboard served by the daemon at `GET /` (and companion routes). It lists every queue with state, concurrency, running/pending/succeeded/failed counts; an instance table per queue with id, state, exit code, duration, enqueue time; and an instance view with merged stdout/stderr that tails live. Counts and states arrive over the SSE event stream; a mid-run page load gets current state immediately. No start/stop/abort buttons in v1 — operational commands stay on the CLI and API.

**Blocked by:** 18

**Status:** done

- [x] Dashboard served at `GET /` by the daemon
- [x] Queue table: id, name, category, state, concurrency, running, pending, succeeded, failed
- [x] Instance table per queue: id, state, exit code, duration, enqueue time
- [x] Instance view: merged stdout/stderr, tails live
- [x] Dashboard updates live via SSE event stream
- [x] Mid-run page load gets current state immediately (no reload required)
- [x] Dashboard is read-only in v1: no start/stop/abort buttons
- [x] Dashboard assets served from the daemon process (inline HTML/JS or static files)
