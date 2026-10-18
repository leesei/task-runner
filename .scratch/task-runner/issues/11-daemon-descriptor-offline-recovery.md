# 11: Daemon descriptor, offline enqueue pickup, and crash recovery behavior

**What to build:** The daemon descriptor file (pid + port + dataDir + startedAt) written on start and removed on clean shutdown. CLI daemon discovery: read descriptor, probe `/api/health`. When daemon is down, `add`/`status`/`logs`/`clear` operate directly on SQLite; the daemon polls for newly PENDING instances at ~1 second interval and picks them up. On restart, RUNNING instances reset to PENDING; STOPPED queues stay STOPPED; all other queues autostart. This ticket also wires up the daemon's main loop: discover tasks → create queues → poll for work → drain → handle control events.

**Blocked by:** 09

**Status:** ready-for-agent

- [ ] Daemon writes descriptor file (pid, port, dataDir, startedAt) on start
- [ ] Daemon removes descriptor on clean shutdown (SIGINT/SIGTERM)
- [ ] CLI reads descriptor and probes `/api/health` to discover daemon
- [ ] Daemon polls SQLite for newly PENDING instances at ~1 second interval
- [ ] Offline enqueues (via direct SQLite) are picked up promptly once daemon starts
- [ ] Daemon main loop: discover tasks → create queues → poll → drain → handle control
- [ ] RUNNING instances left at restart are reset to PENDING
- [ ] STOPPED queues stay STOPPED across restart
- [ ] All other queues enter PROCESSING on restart (autostart)
- [ ] Port conflict on start is a clear error, not a silent change
