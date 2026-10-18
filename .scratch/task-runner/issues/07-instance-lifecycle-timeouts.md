# 07: Instance lifecycle, timeouts, and failure mapping

**What to build:** The instance state machine (PENDING → RUNNING → SUCCESS/FAILED; RUNNING → abort → PENDING), per-instance timeout (default 30 minutes, configurable per task via manifest `timeoutMs`), and failure reason recording. A timed-out instance ends FAILED with reason `timeout` and does not return to PENDING. Instances left RUNNING at daemon restart are reset to PENDING. Crash recovery: on start, RUNNING → PENDING so they are retried; STOPPED queues stay STOPPED.

**Blocked by:** 06

**Status:** in-progress

- [ ] Instance state machine: PENDING → RUNNING → SUCCESS; PENDING → RUNNING → FAILED; RUNNING → abort → PENDING
- [ ] Per-instance timeout defaults to 30 minutes, configurable per task in manifest (`timeoutMs`)
- [ ] Timed-out instance ends FAILED with reason `timeout`, does NOT return to PENDING
- [ ] Instance records: exit code, failure reason, started-at, ended-at, duration
- [ ] On daemon start: instances left RUNNING are reset to PENDING (crash recovery)
- [ ] On daemon start: STOPPED queues remain STOPPED
- [ ] On daemon start: all other queues enter PROCESSING
- [ ] Finished instances (SUCCESS/FAILED) are preserved across restart
- [ ] Attempt number is incremented when an instance is retried after abort/crash
