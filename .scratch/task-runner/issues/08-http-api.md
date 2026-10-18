# 08: HTTP API — health, queues, instances, control, events, log streaming

**What to build:** A REST API served by `Bun.serve` alongside the dashboard. Endpoints: `GET /api/health`, `GET /api/queues`, `GET /api/queues/:queueId`, `GET /api/queues/:queueId/instances`, `POST /api/queues/:queueId/start`, `POST /api/queues/:queueId/stop`, `POST /api/queues/:queueId/abort`, `GET /api/tasks`, `POST /api/instances`, `GET /api/instances/:id`, `GET /api/instances/:id/log`, `GET /api/events` (SSE), `GET /api/instances/:id/log/stream` (SSE), `POST /api/reload`. Unknown queue or instance ids return a structured error with a stable code and human-readable message. Queue id is the task id (`namespace:id`). Slow event consumers are dropped rather than buffered without bound.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] `GET /api/health` returns liveness + pid, port, dataDir, startedAt
- [ ] `GET /api/queues` returns list with state, concurrency, running, pending, succeeded, failed counts
- [ ] `GET /api/queues/:queueId` returns queue detail
- [ ] `GET /api/queues/:queueId/instances` returns instances newest-first, with optional state filter
- [ ] `POST /api/queues/:queueId/start` starts a queue
- [ ] `POST /api/queues/:queueId/stop` stops a queue
- [ ] `POST /api/queues/:queueId/abort` aborts running instances and stops the queue
- [ ] `GET /api/tasks` returns registered task definitions with name, category, concurrency, schema
- [ ] `POST /api/instances` enqueues an instance (`{ task, input }`)
- [ ] `GET /api/instances/:id` returns instance detail
- [ ] `GET /api/instances/:id/log` returns merged log content (JSONL parsed into ordered records)
- [ ] `GET /api/events` is SSE for queue and instance state changes
- [ ] `GET /api/instances/:id/log/stream` is SSE: replay log from start, then follow
- [ ] `POST /api/reload` reloads task definitions
- [ ] Unknown queue/instance ids return structured error with stable code + human message
- [ ] Slow SSE consumers are dropped rather than buffered without bound
