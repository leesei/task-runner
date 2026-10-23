# 04: Queue registry, state machines, and autostart

**What to build:** On discovery, each registered task gets a queue row (queue id = task id). Queues start in IDLE and transition to PROCESSING when there is work. On daemon start, queues that were STOPPED stay STOPPED; all other queues enter PROCESSING (autostart). The runner loop picks PENDING instances from PROCESSING queues in FIFO order (by instance id), respecting per-queue concurrency, and launches them. Queue state transitions are persisted to SQLite so a restart preserves STOPPED queues.

**Blocked by:** 03

**Status:** done

- [ ] Each registered task creates a queue row with queue id = task id, state = IDLE, concurrency from manifest
- [ ] Queue state machine: IDLE ⇄ PROCESSING; PROCESSING → STOPPED (stop/abort); STOPPED → PROCESSING (start); PROCESSING → IDLE (drained)
- [ ] On daemon start: STOPPED queues stay STOPPED; all other queues enter PROCESSING (autostart)
- [ ] Runner loop picks PENDING instances from PROCESSING queues in FIFO order (by instance id)
- [ ] Runner respects per-queue concurrency: never launches more than `concurrency` instances concurrently
- [ ] Queue state transitions are persisted to SQLite
- [ ] A queue with no PENDING and no RUNNING instances transitions to IDLE
- [ ] A PENDING instance added to an IDLE queue triggers immediate pickup
- [ ] A PENDING instance added to a STOPPED queue stays PENDING (no automatic launch)
