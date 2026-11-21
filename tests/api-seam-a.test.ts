import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createApi, type RequestTimeoutSetter } from "../src/api/index.ts";
import {
  bootstrapDataDir,
  closeDatabase,
  configureDatabase,
  openDatabase,
  resolveDataDir,
} from "../src/db/database.ts";
import { installConsoleInterception } from "../src/runner/execution.ts";
import { createRunner } from "../src/runner/runner.ts";
import { createHarness, type TestHarness } from "./support/harness.ts";
import { loadAllTasks } from "../src/tasks/discovery.ts";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tq-test-"));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}

function writeTask(dir: string, name: string, files: Record<string, string>) {
  const taskDir = join(dir, name);
  mkdirSync(taskDir, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    writeFileSync(join(taskDir, k), v);
  }
}

describe("Seam A: Daemon HTTP API", () => {
  let dataDir: string;
  let projectDir: string;
  let db: any;
  let api: (req: Request, server?: RequestTimeoutSetter) => Promise<Response>;
  let runner: any;
  let harness: TestHarness;
  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = makeTempDir();
    projectDir = makeTempDir();

    const dbConfig = resolveDataDir(dataDir);
    bootstrapDataDir(dbConfig);
    db = openDatabase(dbConfig.dbPath);
    configureDatabase(db);

    // Create fixture tasks
    writeTask(join(projectDir, "tasks"), "success", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "success",
        name: "Success task",
        concurrency: 1,
      }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# success",
    });
    writeTask(join(projectDir, "tasks"), "fail", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "fail",
        name: "Fail task",
        concurrency: 1,
      }),
      "index.ts": `export default async function(ctx) { ctx.done(1); }`,
      "README.md": "# fail",
    });
    writeTask(join(projectDir, "tasks"), "throw", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "throw",
        name: "Throw task",
        concurrency: 1,
      }),
      "index.ts": `export default async function(ctx) { throw new Error("boom"); }`,
      "README.md": "# throw",
    });
    writeTask(join(projectDir, "tasks"), "slow", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "slow",
        name: "Slow task",
        concurrency: 2,
        timeoutMs: 60000,
      }),
      "index.ts": `export default async function(ctx) {
        let count = 0;
        while (count < 50 && !ctx.signal.aborted) {
          await new Promise(r => setTimeout(r, 5));
          count++;
        }
        if (ctx.signal.aborted) { ctx.done(124); return; }
        ctx.done(0);
      }`,
      "README.md": "# slow",
    });
    writeTask(join(projectDir, "tasks"), "noisy", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "noisy",
        name: "Noisy task",
        concurrency: 1,
      }),
      "index.ts": `export default async function(ctx) { console.log("hello"); console.error("world"); ctx.done(0); }`,
      "README.md": "# noisy",
    });
    writeTask(join(projectDir, "tasks"), "echo", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "echo",
        name: "Echo task",
        concurrency: 1,
      }),
      "index.ts": `export default async function(ctx) { console.log(JSON.stringify(ctx.input)); ctx.done(0); }`,
      "README.md": "# echo",
    });
    writeTask(join(projectDir, "tasks"), "noschema", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "noschema",
        name: "No schema task",
        concurrency: 1,
      }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# noschema",
    });
    writeTask(join(projectDir, "tasks"), "validated", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "validated",
        name: "Validated task",
        concurrency: 1,
        inputSchema: "schema.json",
      }),
      "schema.json": JSON.stringify({
        type: "object",
        properties: { mode: { type: "string", default: "fast" } },
      }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# validated",
    });

    loadAllTasks(db, projectDir, []);
    harness = createHarness(db, dataDir, projectDir);
    harness.lifecycle.syncQueues();
    harness.lifecycle.recoverOnBoot();
    installConsoleInterception();

    api = createApi({ core: harness.core, events: harness.events, dataDir, cwd: projectDir });
    runner = createRunner({ db, lifecycle: harness.lifecycle, pollIntervalMs: 5 });

    server = Bun.serve({ port: 0, fetch: api });
    baseUrl = `http://localhost:${server.port}`;
    runner.runContinuous().catch(() => {});
  });

  afterAll(() => {
    server?.stop();
    if (db) closeDatabase(db);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {}
  });

  test("health endpoint", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; pid?: number };
    expect(body.status).toBe("ok");
    expect(body.pid).toBeDefined();
  });

  test("tasks endpoint lists registered tasks", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const tasks = (await res.json()) as Array<{
      id: string;
      has_schema: boolean;
      schema: unknown;
    }>;
    expect(tasks.length).toBeGreaterThan(0);
    const validated = tasks.find((task) => task.id === "default:validated");
    expect(validated?.has_schema).toBe(true);
    expect(validated?.schema).toEqual({
      type: "object",
      properties: { mode: { type: "string", default: "fast" } },
    });
  });

  test("queues endpoint", async () => {
    const res = await fetch(`${baseUrl}/api/queues`);
    expect(res.status).toBe(200);
    const queues = (await res.json()) as Array<{ total: number }>;
    expect(Array.isArray(queues)).toBe(true);
    expect(queues.every((queue) => typeof queue.total === "number")).toBe(true);
  });

  test("enqueue returns the normalized context with schema defaults", async () => {
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "default:validated", input: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input?: unknown };
    expect(body.input).toEqual({ mode: "fast" });
  });

  test("enqueue instance", async () => {
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "default:success", input: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: number; task?: string };
    expect(body.id).toBeDefined();
    expect(body.task).toBe("default:success");
  });

  test("enqueue accepts an optional unique string id and rejects duplicates", async () => {
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "default:success",
        input: {},
        id: "job-7001",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id?: number;
      user_id?: string | null;
    };
    expect(body.id).toBeDefined();
    expect(body.user_id).toBe("job-7001");

    const detailRes = await fetch(`${baseUrl}/api/instances/${body.id}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      task_id: string;
      user_id: string;
    };
    expect(detail.task_id).toBe("default:success");
    expect(detail.user_id).toBe("job-7001");

    const duplicate = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "default:success",
        input: {},
        id: "job-7001",
      }),
    });
    expect(duplicate.status).toBe(409);
    const error = (await duplicate.json()) as { code?: string };
    expect(error.code).toBe("INSTANCE_ID_CONFLICT");
  });

  test("enqueue derives user_id from a string context id", async () => {
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "default:echo",
        input: { id: "ctx-7002", x: 1 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id?: number;
      user_id?: string | null;
      input?: unknown;
    };
    expect(body.user_id).toBe("ctx-7002");
    expect(body.input).toEqual({ id: "ctx-7002", x: 1 });

    const duplicate = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "default:echo",
        input: { id: "ctx-7002", x: 2 },
      }),
    });
    expect(duplicate.status).toBe(409);
    const error = (await duplicate.json()) as { code?: string };
    expect(error.code).toBe("INSTANCE_ID_CONFLICT");
  });

  test("enqueue rejects invalid ids", async () => {
    for (const id of [0, -1, 1.5, true, null, "", "   "]) {
      const res = await fetch(`${baseUrl}/api/instances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "default:success", input: {}, id }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("INVALID_REQUEST");
    }
  });

  test("enqueue stores the default and explicit working directory", async () => {
    const target = join(projectDir, "workdir");
    mkdirSync(target, { recursive: true });

    const explicitRes = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "default:success", input: {}, cwd: target }),
    });
    expect(explicitRes.status).toBe(200);
    const explicit = (await explicitRes.json()) as { id: number; cwd: string };
    expect(explicit.cwd).toBe(target);

    const defaultRes = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "default:success", input: {} }),
    });
    expect(defaultRes.status).toBe(200);
    const fallback = (await defaultRes.json()) as { cwd: string };
    expect(fallback.cwd).toBe(projectDir);

    const detailRes = await fetch(`${baseUrl}/api/instances/${explicit.id}`);
    const detail = (await detailRes.json()) as { cwd: string };
    expect(detail.cwd).toBe(target);

    const listRes = await fetch(
      `${baseUrl}/api/queues/default:success/instances`,
    );
    const list = (await listRes.json()) as Array<{ cwd: string }>;
    expect(list.some((instance) => instance.cwd === target)).toBe(true);
  });

  test("invalid cwd is rejected without creating an instance", async () => {
    const before = harness.core.listInstances("default:validated").length;
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "default:validated",
        input: {},
        cwd: "relative/path",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_CWD");
    expect(harness.core.listInstances("default:validated").length).toBe(before);
  });

  test("unknown task id returns error", async () => {
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "nope:nope", input: {} }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("TASK_NOT_FOUND");
  });

  test("malformed JSON returns error", async () => {
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_JSON");
  });

  test("events endpoint streams lifecycle events", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain(": connected");

    const { id } = harness.core.enqueue("default:echo", { source: "sse" });
    const next = await reader.read();
    const frame = decoder.decode(next.value);
    expect(frame).toContain("event: instanceStateChanged");
    expect(frame).toContain(String(id));

    controller.abort();
    try {
      await reader.cancel();
    } catch {}
  });

  test("SSE routes disable Bun's idle timeout", async () => {
    const calls: Array<{ path: string; seconds: number }> = [];
    const fakeServer: RequestTimeoutSetter = {
      timeout(req, seconds) {
        calls.push({ path: new URL(req.url).pathname, seconds });
      },
    };

    const eventsRes = await api(
      new Request(`${baseUrl}/api/events`),
      fakeServer,
    );
    expect(eventsRes.headers.get("content-type")).toContain("text/event-stream");
    await eventsRes.body?.cancel();

    const { id } = harness.core.enqueue("default:echo", {});
    const logRes = await api(
      new Request(`${baseUrl}/api/instances/${id}/log/stream`),
      fakeServer,
    );
    expect(logRes.headers.get("content-type")).toContain("text/event-stream");
    await logRes.body?.cancel();

    expect(calls).toEqual([
      { path: "/api/events", seconds: 0 },
      { path: `/api/instances/${id}/log/stream`, seconds: 0 },
    ]);
  });

  test("log stream replays existing records and then tails the file", async () => {
    const { id } = harness.core.enqueue("default:noisy", {});
    await waitFor(() => harness.core.getInstance(id)!.state === "SUCCESS");

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/instances/${id}/log/stream`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("hello");
    expect(text).toContain("world");

    controller.abort();
    try {
      await reader.cancel();
    } catch {}
  });

  test("delete instance removes a finished instance and its log", async () => {
    const { id } = harness.core.enqueue("default:success", {});
    await waitFor(() => harness.core.getInstance(id)!.state === "SUCCESS");
    const logPath = harness.core.getInstance(id)!.log_path!;
    expect(existsSync(logPath)).toBe(true);

    const res = await fetch(`${baseUrl}/api/instances/${id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      deleted: number;
      instanceId: number;
      queueId: string;
    };
    expect(body).toEqual({
      success: true,
      deleted: 1,
      instanceId: id,
      queueId: "default:success",
    });
    expect(harness.core.getInstance(id)).toBeNull();
    expect(existsSync(logPath)).toBe(false);
  });

  test("delete instance removes a running instance and idles the queue", async () => {
    const { id } = harness.core.enqueue("default:slow", {});
    await waitFor(() => harness.core.getInstance(id)!.state === "RUNNING");

    const res = await fetch(`${baseUrl}/api/instances/${id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(harness.core.getInstance(id)).toBeNull();
    expect(harness.core.getQueue("default:slow")!.state).toBe("IDLE");
  });

  test("queue stop pauses the queue and start resumes it", async () => {
    const stop = await fetch(`${baseUrl}/api/queues/default:noschema/stop`, {
      method: "POST",
    });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ success: true, state: "STOPPED" });
    expect(harness.core.getQueue("default:noschema")!.state).toBe("STOPPED");

    const start = await fetch(`${baseUrl}/api/queues/default:noschema/start`, {
      method: "POST",
    });
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ success: true, state: "IDLE" });
    expect(harness.core.getQueue("default:noschema")!.state).toBe("IDLE");
  });

  test("delete unknown instance returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/instances/999999`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INSTANCE_NOT_FOUND");
  });
});
