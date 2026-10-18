# 08: HTTP API — health, queues, instances, control, events, log streaming

**What to build:** A REST API served by `Bun.serve` alongside the dashboard. Endpoints: `GET /api/health`, `GET /api/queues`, `GET /api/queues/:queueId`, `GET /api/queues/:queueId/instances`, `POST /api/queues/:queueId/start`, `POST /api/queues/:queueId/stop`, `POST /api/queues/:queueId/abort`, `GET /api/tasks`, `POST /api/instances`, `GET /api/instances/:id`, `GET /api/instances/:id/log`, `GET /api/events` (SSE), `GET /api/instances/:id/log/stream` (SSE), `POST /api/reload`. Unknown queue or instance ids return a structured error with a stable code and human-readable message. Queue id is the task id (`namespace:id`). Slow event consumers are dropped rather than buffered without bound.

**Blocked by:** 07

**Status:** resolved

- [x] `GET /api/health` returns liveness + pid, port, dataDir, startedAt
- [x] `GET /api/queues` returns list with state, concurrency, running, pending, succeeded, failed counts
- [x] `GET /api/queues/:queueId` returns queue detail
- [x] `GET /api/queues/:queueId/instances` returns instances newest-first, with optional state filter
- [x] `POST /api/queues/:queueId/start` starts a queue
- [x] `POST /api/queues/:queueId/stop` stops a queue
- [x] `POST /api/queues/:queueId/abort` aborts running instances and stops the queue
- [x] `GET /api/tasks` returns registered task definitions with name, category, concurrency, schema
- [x] `POST /api/instances` enqueues an instance (`{ task, input }`)
- [x] `GET /api/instances/:id` returns instance detail
- [x] `GET /api/instances/:id/log` returns merged log content (JSONL parsed into ordered records)
- [x] `GET /api/events` is SSE for queue and instance state changes
- [x] `GET /api/instances/:id/log/stream` is SSE: replay log from start, then follow
- [x] `POST /api/reload` reloads task definitions
- [x] Unknown queue/instance ids return structured error with stable code + human message
- [x] Slow SSE consumers are dropped rather than buffered without bound
