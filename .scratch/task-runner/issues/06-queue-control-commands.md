# 06: Queue control commands — start, stop, abort, clear

**What to build:** Queue control operations. `stop`: stop launching new instances, let RUNNING finish, queue ends STOPPED. `start`: queue enters PROCESSING and drains PENDING in enqueue order. `abort`: signal RUNNING instance(s), return them to PENDING with partial logs, leave queue STOPPED; does not start pending work. `clear <queue>`: delete SUCCESS instances and their log files. `clear --all <queue>`: delete all finished instances and logs; refuses and lists running ids if any instance is RUNNING. These operations live in the shared core. `start`/`stop` update queue state directly. `abort` writes a durable control request consumed by the daemon runner, which signals running executions and returns instances to PENDING. CLI and HTTP adapters call the same functions; the CLI never uses HTTP.

**Blocked by:** 05

**Status:** done

- [ ] `tq start <queue>`: queue enters PROCESSING, drains PENDING instances in enqueue order
- [ ] `tq stop <queue>`: stops launching new instances, lets RUNNING finish, queue ends STOPPED
- [ ] `tq abort <queue>`: signals RUNNING instances, returns them to PENDING with partial logs, queue stays STOPPED
- [ ] `tq abort <queue>`: does not start any pending work
- [ ] `tq clear <queue>`: deletes SUCCESS instances and their log files
- [ ] `tq clear --all <queue>`: deletes all finished instances and logs; refuses if any RUNNING, lists running ids
- [ ] Control commands require a live daemon (descriptor pid, no HTTP health probe)
- [ ] `abort` writes a control request consumed by the runner on its next tick
- [ ] `start`/`stop`/`abort`/`clear` use shared core functions from both CLI and HTTP
- [ ] `clear` and `status` work offline (directly on SQLite) when daemon is not running
- [ ] Queue state changes are persisted so they survive a restart
