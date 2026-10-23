/**
 * HTTP API for the task runner daemon.
 *
 * Served by Bun.serve alongside the dashboard.
 * All endpoints operate on the daemon's database.
 *
 * Endpoints:
 *   GET  /api/health                          — liveness + daemon info
 *   GET  /api/queues                          — list queues with counts
 *   GET  /api/queues/:queueId                 — queue detail
 *   GET  /api/queues/:queueId/instances       — instances newest-first
 *   POST /api/queues/:queueId/start           — start a queue
 *   POST /api/queues/:queueId/stop            — stop a queue
 *   POST /api/queues/:queueId/abort           — abort + stop
 *   GET  /api/tasks                            — registered task definitions
 *   POST /api/instances                       — enqueue an instance
 *   GET  /api/instances/:id                   — instance detail
 *   GET  /api/instances/:id/log               — merged log content
 *   GET  /api/events                          — SSE: queue + instance state changes
 *   GET  /api/instances/:id/log/stream        — SSE: replay + follow log
 *   POST /api/reload                          — reload task definitions
 */

import type { DB } from "../db/database.ts";
import { getInstance, getInstancesByQueue, getQueue } from "../db/queries.ts";
import { readLogFile } from "../db/logs.ts";
import {
  abortQueue,
  clearQueue,
  CoreError,
  enqueueTask,
  getQueueSummary,
  listQueues,
  listTasks,
  readInstanceLog,
  reloadTasks,
  startQueue,
  stopQueue,
} from "../core/service.ts";
import type { QueueState, InstanceState } from "../db/schema.ts";

// ─── Structured errors ──────────────────────────────────────────────────────────

export interface ApiError {
  code: string;
  message: string;
}

function jsonError(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ code, message } as ApiError),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

// ─── Event system for SSE ───────────────────────────────────────────────────────

/** Global event emitters, one per daemon process. */
const queueListeners = new Set<(q: QueueEvent) => void>();
const instanceListeners = new Set<(i: InstanceEvent) => void>();

export interface QueueEvent {
  type: "queueStateChanged";
  queueId: string;
  state: QueueState;
}

export interface InstanceEvent {
  type: "instanceStateChanged";
  instanceId: number;
  state: InstanceState;
}

export function emitQueueStateChanged(queueId: string, state: QueueState): void {
  const evt: QueueEvent = { type: "queueStateChanged", queueId, state };
  for (const cb of queueListeners) {
    try { cb(evt); } catch {}
  }
}

export function emitInstanceStateChanged(instanceId: number, state: InstanceState): void {
  const evt: InstanceEvent = { type: "instanceStateChanged", instanceId, state };
  for (const cb of instanceListeners) {
    try { cb(evt); } catch {}
  }
}

// ─── API handlers ───────────────────────────────────────────────────────────────

interface ApiHandlers {
  db: DB;
  dataDir: string;
  cwd: string;
}

export function createApi(h: ApiHandlers) {
  const db = h.db;
  const dataDir = h.dataDir;
  const cwd = h.cwd;

  // ─── Health ──────────────────────────────────────────────────────────────────

  function handleHealth(): Response {
    const descriptorPath = `${dataDir}/daemon.json`;
    let descriptor: { pid: number; port: number; startedAt: string } | null = null;
    try {
      const raw = require("node:fs").readFileSync(descriptorPath, "utf-8");
      descriptor = JSON.parse(raw);
    } catch {}

    return new Response(
      JSON.stringify({
        status: "ok",
        pid: descriptor?.pid ?? process.pid,
        port: descriptor?.port ?? null,
        dataDir,
        startedAt: descriptor?.startedAt ?? null,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // ─── Queues ──────────────────────────────────────────────────────────────────

  function handleQueues(): Response {
    return new Response(JSON.stringify(listQueues(db)), {
      headers: { "Content-Type": "application/json" },
    });
  }

  function handleQueueDetail(queueId: string): Response {
    const queue = getQueueSummary(db, queueId);
    if (!queue) {
      return jsonError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`, 404);
    }
    return new Response(JSON.stringify(queue), {
      headers: { "Content-Type": "application/json" },
    });
  }

  function handleQueueInstances(queueId: string, stateFilter?: string): Response {
    const queue = getQueue(db, queueId);
    if (!queue) {
      return jsonError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`, 404);
    }

    let instances = getInstancesByQueue(db, queueId);
    if (stateFilter && stateFilter !== "all") {
      const validStates: InstanceState[] = ["PENDING", "RUNNING", "SUCCESS", "FAILED"];
      if (!validStates.includes(stateFilter as InstanceState)) {
        return jsonError(
          "INVALID_STATE_FILTER",
          `Invalid state filter: ${stateFilter}. Valid: ${validStates.join(", ")}`,
          400,
        );
      }
      instances = instances.filter(i => i.state === stateFilter);
    }

    return new Response(
      JSON.stringify(
        instances.map(i => ({
          id: i.id,
          state: i.state,
          exit_code: i.exit_code,
          failure_reason: i.failure_reason,
          attempt: i.attempt,
          duration_ms: i.duration_ms,
          created_at: i.created_at,
          started_at: i.started_at,
          ended_at: i.ended_at,
          input: JSON.parse(i.input),
        })),
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // ─── Queue control ───────────────────────────────────────────────────────────

  function handleStartQueue(queueId: string): Response {
    const result = startQueue(db, queueId);
    if (!result.success) {
      if (result.message.includes("not found")) {
        return jsonError("QUEUE_NOT_FOUND", result.message, 404);
      }
      return jsonError("INVALID_TRANSITION", result.message, 409);
    }
    emitQueueStateChanged(queueId, "PROCESSING");
    return new Response(
      JSON.stringify({ success: true, message: result.message, state: result.queueState }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  function handleStopQueue(queueId: string): Response {
    const result = stopQueue(db, queueId);
    if (!result.success) {
      if (result.message.includes("not found")) {
        return jsonError("QUEUE_NOT_FOUND", result.message, 404);
      }
      return jsonError("INVALID_TRANSITION", result.message, 409);
    }
    emitQueueStateChanged(queueId, "STOPPED");
    return new Response(
      JSON.stringify({ success: true, message: result.message, state: result.queueState }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  async function handleAbortQueue(queueId: string): Promise<Response> {
    const result = await abortQueue(db, queueId);
    if (!result.success) {
      if (result.message.includes("not found")) {
        return jsonError("QUEUE_NOT_FOUND", result.message, 404);
      }
      if (result.message.includes("Timed out")) {
        return jsonError("CONTROL_TIMEOUT", result.message, 504);
      }
      return jsonError("INVALID_TRANSITION", result.message, 409);
    }
    emitQueueStateChanged(queueId, "STOPPED");
    for (const id of result.runningIds ?? []) {
      emitInstanceStateChanged(id, "PENDING");
    }
    return new Response(
      JSON.stringify({
        success: true,
        message: result.message,
        state: result.queueState,
        returnedToPending: result.runningIds,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // ─── Tasks ───────────────────────────────────────────────────────────────────

  function handleTasks(): Response {
    return new Response(JSON.stringify(listTasks(db)), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Instances ───────────────────────────────────────────────────────────────

  function handleEnqueueInstance(body: { task: string; input: unknown }): Response {
    try {
      const id = enqueueTask(db, body.task, body.input);
      return new Response(
        JSON.stringify({ id, task: body.task, input: body.input }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      if (err instanceof CoreError && err.code === "TASK_NOT_FOUND") {
        return jsonError(err.code, err.message, 404);
      }
      throw err;
    }
  }

  function handleInstanceDetail(instanceId: number): Response {
    const instance = getInstance(db, instanceId);
    if (!instance) {
      return jsonError("INSTANCE_NOT_FOUND", `Instance not found: ${instanceId}`, 404);
    }
    return new Response(
      JSON.stringify({
        id: instance.id,
        task_id: instance.task_id,
        state: instance.state,
        exit_code: instance.exit_code,
        failure_reason: instance.failure_reason,
        attempt: instance.attempt,
        duration_ms: instance.duration_ms,
        created_at: instance.created_at,
        started_at: instance.started_at,
        ended_at: instance.ended_at,
        input: JSON.parse(instance.input),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  function handleInstanceLog(instanceId: number): Response {
    const log = readInstanceLog(db, instanceId);
    if (!log) {
      return jsonError("INSTANCE_NOT_FOUND", `Instance not found: ${instanceId}`, 404);
    }
    return new Response(JSON.stringify(log.records), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Reload ──────────────────────────────────────────────────────────────────

  function handleReload(): Response {
    const { loaded, warnings } = reloadTasks(db, cwd, dataDir);
    return new Response(
      JSON.stringify({ reloaded: loaded, warnings }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  function handleClearQueue(queueId: string, all: boolean): Response {
    const result = clearQueue(db, queueId, all);
    if (!result.success) {
      if (result.message.includes("not found")) {
        return jsonError("QUEUE_NOT_FOUND", result.message, 404);
      }
      return new Response(
        JSON.stringify({
          success: false,
          code: "CLEAR_REFUSED_RUNNING",
          message: result.message,
          runningIds: result.runningIds ?? [],
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ success: true, deleted: result.deletedCount ?? 0, queueId }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // ─── Router ──────────────────────────────────────────────────────────────────

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    try {
      // Strip /api prefix
      const apiPath = pathname.replace(/^\/api\//, "");

      // Health: GET /api/health
      if (apiPath === "health") {
        return req.method === "GET" ? handleHealth() : jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
      }

      // Events SSE: GET /api/events
      if (apiPath === "events") {
        return req.method === "GET" ? handleEventsSSE(req) : jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
      }

      // Tasks: GET /api/tasks
      if (apiPath === "tasks") {
        return req.method === "GET" ? handleTasks() : jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
      }

      // Reload: POST /api/reload
      if (apiPath === "reload") {
        return req.method === "POST" ? handleReload() : jsonError("METHOD_NOT_ALLOWED", "Only POST allowed", 405);
      }

      // Queues collection: GET /api/queues
      if (apiPath === "queues") {
        return req.method === "GET" ? handleQueues() : jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
      }

      // Queue resource: /api/queues/:queueId[/:subresource]
      const queueMatch = apiPath.match(/^queues\/([^\/]+)((?:\/.*)?)$/);
      if (queueMatch && queueMatch[1]) {
        const queueId = decodeURIComponent(queueMatch[1]);
        const subPath = queueMatch[2] ?? "";

        if (subPath === "") {
          if (req.method === "GET") return handleQueueDetail(queueId);
          if (req.method === "POST" && url.searchParams.get("clear") === "success") return handleClearQueue(queueId, false);
          if (req.method === "POST" && url.searchParams.get("clear") === "all") return handleClearQueue(queueId, true);
          return jsonError("NOT_FOUND", `No handler for /api/queues/${queueId}`, 404);
        }

        if (subPath === "/instances") {
          if (req.method !== "GET") return jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
          const stateFilter = url.searchParams.get("state");
          return handleQueueInstances(queueId, stateFilter ?? undefined);
        }

        if (subPath === "/start") {
          return req.method === "POST" ? handleStartQueue(queueId) : jsonError("METHOD_NOT_ALLOWED", "Only POST allowed", 405);
        }

        if (subPath === "/stop") {
          return req.method === "POST" ? handleStopQueue(queueId) : jsonError("METHOD_NOT_ALLOWED", "Only POST allowed", 405);
        }

        if (subPath === "/abort") {
          return req.method === "POST" ? await handleAbortQueue(queueId) : jsonError("METHOD_NOT_ALLOWED", "Only POST allowed", 405);
        }

        return jsonError("NOT_FOUND", `Unknown queue sub-resource: ${subPath}`, 404);
      }

      // Instances collection: POST /api/instances
      if (apiPath === "instances") {
        if (req.method === "POST") return await handleEnqueue(req);
        return jsonError("METHOD_NOT_ALLOWED", "Only POST allowed", 405);
      }

      // Instance resource: /api/instances/:id[/:subresource]
      const instanceMatch = apiPath.match(/^instances\/(\d+)((?:\/.*)?)$/);
      if (instanceMatch && instanceMatch[1]) {
        const instanceId = parseInt(instanceMatch[1], 10);
        const subPath = instanceMatch[2] ?? "";

        if (subPath === "") {
          if (req.method === "GET") return handleInstanceDetail(instanceId);
          return jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
        }

        if (subPath === "/log") {
          if (req.method !== "GET") return jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
          return handleInstanceLog(instanceId);
        }

        if (subPath === "/log/stream") {
          if (req.method !== "GET") return jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
          return handleLogStream(instanceId, req);
        }

        return jsonError("NOT_FOUND", `Unknown instance sub-resource: ${subPath}`, 404);
      }

      return jsonError("NOT_FOUND", `Unknown endpoint: ${pathname}`, 404);
    } catch (err: any) {
      return jsonError("INTERNAL_ERROR", err?.message ?? "Internal error", 500);
    }
  }

  async function handleEnqueue(req: Request): Promise<Response> {
    let body: { task: string; input: unknown };
    try {
      const json = await req.json();
      if (!json || typeof (json as { task?: unknown }).task !== "string") {
        return jsonError("INVALID_REQUEST", "Request body must be { task: string, input: any }", 400);
      }
      body = json as { task: string; input: unknown };
    } catch {
      return jsonError("INVALID_JSON", "Request body must be valid JSON", 400);
    }
    return handleEnqueueInstance(body);
  }

  // ─── Events SSE ──────────────────────────────────────────────────────────────

  function handleEventsSSE(req: Request): Response {
    const encoder = new TextEncoder();
    let queueDone = false;
    let instanceDone = false;

    const stream = new ReadableStream({
      start(controller) {
        // Send keepalive comment
        controller.enqueue(encoder.encode(": connected\n\n"));

        const onQueueEvent = (evt: QueueEvent) => {
          if (queueDone) return;
          try {
            controller.enqueue(
              encoder.encode(`event: queueStateChanged\ndata: ${JSON.stringify({ queueId: evt.queueId, state: evt.state })}\n\n`),
            );
          } catch { queueDone = true; }
        };

        const onInstanceEvent = (evt: InstanceEvent) => {
          if (instanceDone) return;
          try {
            controller.enqueue(
              encoder.encode(`event: instanceStateChanged\ndata: ${JSON.stringify({ instanceId: evt.instanceId, state: evt.state })}\n\n`),
            );
          } catch { instanceDone = true; }
        };

        queueListeners.add(onQueueEvent);
        instanceListeners.add(onInstanceEvent);

        const onAbort = () => {
          queueDone = true;
          instanceDone = true;
          queueListeners.delete(onQueueEvent);
          instanceListeners.delete(onInstanceEvent);
          try { controller.close(); } catch {}
        };

        req.signal.addEventListener("abort", onAbort);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  // ─── Log stream SSE ──────────────────────────────────────────────────────────

  function handleLogStream(instanceId: number, req: Request): Response {
    const instance = getInstance(db, instanceId);
    if (!instance) {
      return jsonError("INSTANCE_NOT_FOUND", `Instance not found: ${instanceId}`, 404);
    }

    const encoder = new TextEncoder();
    let closed = false;
    let lastIndex = 0;
    const logPath = instance.log_path;

    const stream = new ReadableStream({
      start(controller) {
        // Replay existing log from the beginning
        const pushExisting = () => {
          if (closed || !logPath) { try { controller.close(); } catch {} return; }
          try {
            const records = readLogFile(logPath);
            for (let i = lastIndex; i < records.length; i++) {
              if (closed) break;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ timestamp: records[i]!.timestamp, stream: records[i]!.stream, text: records[i]!.text })}\n\n`,
                ),
              );
              lastIndex = i + 1;
            }
          } catch {}
          setTimeout(pushExisting, 500);
        };

        pushExisting();

        const onAbort = () => {
          closed = true;
          try { controller.close(); } catch {}
        };

        req.signal.addEventListener("abort", onAbort);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  return route;
}