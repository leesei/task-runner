# 11: Daemon descriptor, offline enqueue pickup, and crash recovery behavior

**What to build:** The daemon descriptor file (pid + port + dataDir + startedAt) written on start and removed on clean shutdown. CLI daemon discovery reads the descriptor and checks pid liveness with `process.kill(pid, 0)`; it never probes `/api/health` or any HTTP endpoint. `add`/`status`/`logs`/`clear` always operate directly on SQLite, whether or not the daemon is up. The daemon polls for newly PENDING instances and pending `control_requests` at ~1 second interval. On restart, RUNNING instances reset to PENDING; STOPPED queues stay STOPPED; all other queues autostart. This ticket also wires the daemon main loop: discover tasks → create queues → poll for work → drain → consume abort/reload control requests.

**Blocked by:** 09

**Status:** ready-for-agent

- [ ] Daemon writes descriptor file (pid, port, dataDir, startedAt) on start
- [ ] Daemon removes descriptor on clean shutdown (SIGINT/SIGTERM)
- [ ] CLI reads descriptor and checks pid liveness without HTTP
- [ ] Daemon polls SQLite for newly PENDING instances at ~1 second interval
- [ ] Daemon consumes pending abort/reload control requests on its poll tick
- [ ] Offline enqueues (via direct SQLite) are picked up promptly once daemon starts
- [ ] Daemon main loop: discover tasks → create queues → poll → drain → handle control
- [ ] RUNNING instances left at restart are reset to PENDING
- [ ] STOPPED queues stay STOPPED across restart
- [ ] All other queues enter PROCESSING on restart (autostart)
- [ ] Port conflict on start is a clear error, not a silent change
