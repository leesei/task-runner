/**
 * HTTP API for the task runner daemon.
 *
 * The API is an adapter over core: it parses transport input, calls one core
 * operation, and serializes the result or a structured error. It carries no
 * queue or instance rules. SSE subscribes to the injected event bus.
 */

<<<<<<< HEAD
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
=======
import { CoreError, type Core } from "../core/service.ts";
import type { EventBus, LifecycleEvent } from "../core/events.ts";
import type { InstanceState } from "../db/schema.ts";
import { readLogFile } from "../db/logs.ts";
>>>>>>> feat/task-runner-spec

export interface ApiError {
  code: string;
  message: string;
}

function jsonError(
  code: string,
  message: string,
  status: number,
  issues?: unknown[],
): Response {
  const body: ApiError & { issues?: unknown[] } = { code, message };
  if (issues !== undefined) body.issues = issues;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function coreErrorResponse(err: unknown): Response {
  if (!(err instanceof CoreError)) {
    return jsonError("INTERNAL_ERROR", err instanceof Error ? err.message : "Internal error", 500);
  }
  switch (err.code) {
    case "TASK_NOT_FOUND":
    case "QUEUE_NOT_FOUND":
    case "INSTANCE_NOT_FOUND":
      return jsonError(err.code, err.message, 404);
    case "INPUT_SCHEMA_VIOLATION":
      return jsonError(err.code, err.message, 400, err.issues ?? []);
    case "CLEAR_REFUSED_RUNNING":
      return new Response(
        JSON.stringify({
          code: err.code,
          message: err.message,
          runningIds: err.runningIds ?? [],
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    case "CONTROL_TIMEOUT":
      return jsonError(err.code, err.message, 504);
    case "INVALID_CONCURRENCY":
    case "INVALID_TRANSITION":
      return jsonError(err.code, err.message, 409);
  }
}

export interface ApiHandlers {
  core: Core;
  events: EventBus;
  dataDir: string;
  cwd: string;
}

export function createApi(h: ApiHandlers) {
  const { core, events, dataDir, cwd } = h;

  function handleHealth(): Response {
    const descriptorPath = `${dataDir}/daemon.json`;
    let descriptor: { pid: number; port: number; startedAt: string } | null = null;
    try {
      const raw = require("node:fs").readFileSync(descriptorPath, "utf-8");
      descriptor = JSON.parse(raw);
    } catch {}

<<<<<<< HEAD
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
=======
    return json({
      status: "ok",
      pid: descriptor?.pid ?? process.pid,
      port: descriptor?.port ?? null,
      dataDir,
      startedAt: descriptor?.startedAt ?? null,
>>>>>>> feat/task-runner-spec
    });
  }

  function handleQueueInstances(queueId: string, stateFilter?: string): Response {
    if (!core.getQueue(queueId)) {
      return jsonError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`, 404);
    }

    let state: InstanceState | undefined;
    if (stateFilter && stateFilter !== "all") {
      const validStates: InstanceState[] = ["PENDING", "RUNNING", "SUCCESS", "FAILED"];
      if (!validStates.includes(stateFilter as InstanceState)) {
        return jsonError(
          "INVALID_STATE_FILTER",
          `Invalid state filter: ${stateFilter}. Valid: ${validStates.join(", ")}`,
          400,
        );
      }
      state = stateFilter as InstanceState;
    }

<<<<<<< HEAD
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
=======
    const instances = core.listInstances(queueId, state);
    return json(
      instances.map((instance) => ({
>>>>>>> feat/task-runner-spec
        id: instance.id,
        state: instance.state,
        exit_code: instance.exit_code,
        failure_reason: instance.failure_reason,
        attempt: instance.attempt,
        duration_ms: instance.duration_ms,
        created_at: instance.created_at,
        started_at: instance.started_at,
        ended_at: instance.ended_at,
        input: JSON.parse(instance.input),
      })),
    );
  }

<<<<<<< HEAD
  function handleInstanceLog(instanceId: number): Response {
    const log = readInstanceLog(db, instanceId);
    if (!log) {
      return jsonError("INSTANCE_NOT_FOUND", `Instance not found: ${instanceId}`, 404);
    }
    return new Response(JSON.stringify(log.records), {
      headers: { "Content-Type": "application/json" },
=======
  function handleStartQueue(queueId: string): Response {
    try {
      const state = core.start(queueId);
      return json({ success: true, state });
    } catch (err) {
      return coreErrorResponse(err);
    }
  }

  function handleStopQueue(queueId: string): Response {
    try {
      const state = core.stop(queueId);
      return json({ success: true, state });
    } catch (err) {
      return coreErrorResponse(err);
    }
  }

  async function handleAbortQueue(queueId: string): Promise<Response> {
    try {
      const result = await core.abort(queueId);
      return json({
        success: true,
        state: result.queueState,
        returnedToPending: result.cancelled.map((token) => token.instanceId),
      });
    } catch (err) {
      return coreErrorResponse(err);
    }
  }

  function handleEnqueueInstance(body: { task: string; input: unknown }): Response {
    try {
      const result = core.enqueue(body.task, body.input);
      return json({ id: result.id, task: body.task, input: body.input, createdAt: result.createdAt });
    } catch (err) {
      return coreErrorResponse(err);
    }
  }

  function handleInstanceDetail(instanceId: number): Response {
    const instance = core.getInstance(instanceId);
    if (!instance) {
      return jsonError("INSTANCE_NOT_FOUND", `Instance not found: ${instanceId}`, 404);
    }
    return json({
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
>>>>>>> feat/task-runner-spec
    });
  }

  function handleInstanceLog(instanceId: number): Response {
    const log = core.readInstanceLog(instanceId);
    if (!log) {
      return jsonError("INSTANCE_NOT_FOUND", `Instance not found: ${instanceId}`, 404);
    }
    return json(log.records);
  }

  function handleReload(): Response {
<<<<<<< HEAD
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
=======
    const { loaded, warnings } = core.reload();
    return json({ reloaded: loaded, warnings });
  }

  function handleClearQueue(queueId: string, all: boolean): Response {
    try {
      const result = core.clear(queueId, all);
      return json({ success: true, deleted: result.deleted, queueId });
    } catch (err) {
      return coreErrorResponse(err);
    }
>>>>>>> feat/task-runner-spec
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    try {
      const apiPath = pathname.replace(/^\/api\//, "");

      if (apiPath === "health") {
        return req.method === "GET" ? handleHealth() : jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
      }

      if (apiPath === "events") {
        return req.method === "GET" ? handleEventsSSE(req) : jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
      }

      if (apiPath === "tasks") {
        return req.method === "GET" ? json(core.listTasks()) : jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
      }

      if (apiPath === "reload") {
        return req.method === "POST" ? handleReload() : jsonError("METHOD_NOT_ALLOWED", "Only POST allowed", 405);
      }

      if (apiPath === "queues") {
        return req.method === "GET" ? json(core.listQueues()) : jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
      }

      const queueMatch = apiPath.match(/^queues\/([^\/]+)((?:\/.*)?)$/);
      if (queueMatch && queueMatch[1]) {
        const queueId = decodeURIComponent(queueMatch[1]);
        const subPath = queueMatch[2] ?? "";

        if (subPath === "") {
          if (req.method === "GET") {
            const queue = core.getQueue(queueId);
            if (!queue) return jsonError("QUEUE_NOT_FOUND", `Queue not found: ${queueId}`, 404);
            return json(queue);
          }
          if (req.method === "POST" && url.searchParams.get("clear") === "success") {
            return handleClearQueue(queueId, false);
          }
          if (req.method === "POST" && url.searchParams.get("clear") === "all") {
            return handleClearQueue(queueId, true);
          }
          return jsonError("NOT_FOUND", `No handler for /api/queues/${queueId}`, 404);
        }

        if (subPath === "/instances") {
          if (req.method !== "GET") return jsonError("METHOD_NOT_ALLOWED", "Only GET allowed", 405);
          return handleQueueInstances(queueId, url.searchParams.get("state") ?? undefined);
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

      if (apiPath === "instances") {
        if (req.method === "POST") return await handleEnqueue(req);
        return jsonError("METHOD_NOT_ALLOWED", "Only POST allowed", 405);
      }

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
    } catch (err: unknown) {
      return jsonError("INTERNAL_ERROR", err instanceof Error ? err.message : "Internal error", 500);
    }
  }

  async function handleEnqueue(req: Request): Promise<Response> {
    let body: { task: string; input: unknown };
    try {
      const parsed = await req.json();
      if (!parsed || typeof (parsed as { task?: unknown }).task !== "string") {
        return jsonError("INVALID_REQUEST", "Request body must be { task: string, input: any }", 400);
      }
      body = parsed as { task: string; input: unknown };
    } catch {
      return jsonError("INVALID_JSON", "Request body must be valid JSON", 400);
    }
    return handleEnqueueInstance(body);
  }

  function handleEventsSSE(req: Request): Response {
    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));

        const unsubscribe = events.subscribe((event: LifecycleEvent) => {
          if (closed) return;
          try {
            if (event.type === "instanceStateChanged") {
              controller.enqueue(
                encoder.encode(
                  `event: instanceStateChanged\ndata: ${JSON.stringify({ instanceId: event.instanceId, state: event.state })}\n\n`,
                ),
              );
            } else if (event.type === "queueStateChanged") {
              controller.enqueue(
                encoder.encode(
                  `event: queueStateChanged\ndata: ${JSON.stringify({ queueId: event.queueId, state: event.state })}\n\n`,
                ),
              );
            } else {
              controller.enqueue(
                encoder.encode(
                  `event: instancesCleared\ndata: ${JSON.stringify({ queueId: event.queueId, instanceIds: event.instanceIds })}\n\n`,
                ),
              );
            }
          } catch {
            closed = true;
            unsubscribe();
          }
        });

        const onAbort = () => {
          closed = true;
          unsubscribe();
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

  function handleLogStream(instanceId: number, req: Request): Response {
    const instance = core.getInstance(instanceId);
    if (!instance) {
      return jsonError("INSTANCE_NOT_FOUND", `Instance not found: ${instanceId}`, 404);
    }

    const encoder = new TextEncoder();
    let closed = false;
    let lastIndex = 0;
    const logPath = instance.log_path;

    const stream = new ReadableStream({
      start(controller) {
        const pushExisting = () => {
          if (closed || !logPath) {
            try { controller.close(); } catch {}
            return;
          }
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
