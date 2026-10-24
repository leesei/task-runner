import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createApi } from "../src/api/index.ts";
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
  let api: (req: Request) => Promise<Response>;
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
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.pid).toBeDefined();
  });

  test("tasks endpoint lists registered tasks", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(tasks.length).toBeGreaterThan(0);
  });

  test("queues endpoint", async () => {
    const res = await fetch(`${baseUrl}/api/queues`);
    expect(res.status).toBe(200);
    const queues = await res.json();
    expect(Array.isArray(queues)).toBe(true);
  });

  test("enqueue instance", async () => {
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "default:success", input: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.task).toBe("default:success");
  });

  test("unknown task id returns error", async () => {
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "nope:nope", input: {} }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("TASK_NOT_FOUND");
  });

  test("malformed JSON returns error", async () => {
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_JSON");
  });
});
