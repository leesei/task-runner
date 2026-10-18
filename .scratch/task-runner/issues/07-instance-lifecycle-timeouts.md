# 07: Instance lifecycle, timeouts, and failure mapping

**What to build:** The instance state machine (PENDING → RUNNING → SUCCESS/FAILED; RUNNING → abort → PENDING), per-instance timeout (default 30 minutes, configurable per task via manifest `timeoutMs`), and failure reason recording. A timed-out instance ends FAILED with reason `timeout` and does not return to PENDING. Instances left RUNNING at daemon restart are reset to PENDING. Crash recovery: on start, RUNNING → PENDING so they are retried; STOPPED queues stay STOPPED.

**Blocked by:** 06

**Status:** resolved

- [x] Instance state machine: PENDING → RUNNING → SUCCESS; PENDING → RUNNING → FAILED; RUNNING → abort → PENDING
- [x] Per-instance timeout defaults to 30 minutes, configurable per task in manifest (`timeoutMs`)
- [x] Timed-out instance ends FAILED with reason `timeout`, does NOT return to PENDING
- [x] Instance records: exit code, failure reason, started-at, ended-at, duration
- [x] On daemon start: instances left RUNNING are reset to PENDING (crash recovery)
- [x] On daemon start: STOPPED queues remain STOPPED
- [x] On daemon start: all other queues enter PROCESSING
- [x] Finished instances (SUCCESS/FAILED) are preserved across restart
- [x] Attempt number is incremented when an instance is retried after abort/crash
