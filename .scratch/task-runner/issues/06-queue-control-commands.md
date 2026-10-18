# 06: Queue control commands — start, stop, abort, clear

**What to build:** Queue control operations. `stop`: stop launching new instances, let RUNNING finish, queue ends STOPPED. `start`: queue enters PROCESSING and drains PENDING in enqueue order. `abort`: signal RUNNING instance(s), return them to PENDING with partial logs, leave queue STOPPED; does not start pending work. `clear <queue>`: delete SUCCESS instances and their log files. `clear --all <queue>`: delete all finished instances and logs; refuses and lists running ids if any instance is RUNNING. These commands work through the HTTP API when the daemon is running, and directly on SQLite when it is not (where supported).

**Blocked by:** 05

**Status:** resolved

- [ ] `tq start <queue>`: queue enters PROCESSING, drains PENDING instances in enqueue order
- [ ] `tq stop <queue>`: stops launching new instances, lets RUNNING finish, queue ends STOPPED
- [ ] `tq abort <queue>`: signals RUNNING instances, returns them to PENDING with partial logs, queue stays STOPPED
- [ ] `tq abort <queue>`: does not start any pending work
- [ ] `tq clear <queue>`: deletes SUCCESS instances and their log files
- [ ] `tq clear --all <queue>`: deletes all finished instances and logs; refuses if any RUNNING, lists running ids
- [ ] Control commands require a running daemon and fail clearly when it is not reachable
- [ ] `clear` and `status` work offline (directly on SQLite) when daemon is not running
- [ ] Queue state changes are persisted so they survive a restart
