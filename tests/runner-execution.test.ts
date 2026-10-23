import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapDataDir,
  closeDatabase,
  configureDatabase,
  openDatabase,
  resolveDataDir,
  type DB,
} from "../src/db/database.ts";
import {
  getInstance,
  getPendingControlRequests,
  insertControlRequest,
  insertTask,
} from "../src/db/queries.ts";import { readLogFile } from "../src/db/logs.ts";
import { createLifecycle, type Claim, type Lifecycle } from "../src/core/lifecycle.ts";
import { createCore, type Core } from "../src/core/service.ts";
import { createEventBus } from "../src/core/events.ts";
import { createRunner } from "../src/runner/runner.ts";
import { executeTask, installConsoleInterception } from "../src/runner/execution.ts";
import { loadAllTasks } from "../src/tasks/discovery.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function addTaskFile(
  projectDir: string,
  id: string,
  source: string,
  options: { concurrency?: number; timeoutMs?: number } = {},
): string {
  const dir = join(projectDir, "tasks", id);
  mkdirSync(dir, { recursive: true });
  const entryPoint = join(dir, "index.ts");
  writeFileSync(entryPoint, source);
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      namespace: "default",
      id,
      name: id,
      concurrency: options.concurrency ?? 1,
      timeoutMs: options.timeoutMs,
    }),
  );
  writeFileSync(join(dir, "README.md"), `# ${id}`);
  return entryPoint;
}

function insertTaskRow(
  db: DB,
  id: string,
  entryPoint: string,
  options: { concurrency?: number; timeoutMs?: number } = {},
): void {
  insertTask(db, {
    id,
    namespace: "default",
    name: id,
    description: "",
    category: null,
    concurrency: options.concurrency ?? 1,
    timeout_ms: options.timeoutMs ?? 30_000,
    input_schema: null,
    manifest_hash: null,
    manifest_warnings: null,
    entry_point: entryPoint,
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for condition");
}

function logText(logPath: string | null): string {
  if (!logPath) return "";
  return readLogFile(logPath).map((record) => record.text).join("\n");
}

describe("execution: fence, timeout, and append-only logs", () => {
  let dataDir: string;
  let projectDir: string;
  let db: DB;
  let lifecycle: Lifecycle;

  beforeEach(() => {
    dataDir = makeTempDir("tq-exec-");
    projectDir = makeTempDir("tq-exec-project-");
    const config = resolveDataDir(dataDir);
    bootstrapDataDir(config);
    db = openDatabase(config.dbPath);
    configureDatabase(db);
    lifecycle = createLifecycle({
      db,
      events: createEventBus(),
      logDir: config.logDir,
    });
    installConsoleInterception();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (db) closeDatabase(db);
  });

  test("logs append across attempts and never truncate the aborted attempt", async () => {
    const entryPoint = addTaskFile(
      projectDir,
      "slow",
      `export default async function(ctx) {
        console.log("attempt-started");
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 40);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            console.log("attempt-aborted");
            resolve();
          }, { once: true });
        });
        if (!ctx.signal.aborted) ctx.done(0);
      }`,
    );
    insertTaskRow(db, "default:slow", entryPoint);
    lifecycle.syncQueues();

    const { id } = lifecycle.enqueue("default:slow", {});
    const [first] = lifecycle.claim();
    const firstController = new AbortController();
    const firstRun = executeTask(
      first!,
      lifecycle,
      firstController.signal,
      () => firstController.abort(),
    );

    await waitFor(() => logText(getInstance(db, id)!.log_path).includes("attempt-started"));
    lifecycle.abortQueue("default:slow");
    firstController.abort();
    await firstRun;

    expect(getInstance(db, id)!.state).toBe("PENDING");
    expect(getInstance(db, id)!.attempt).toBe(2);

    lifecycle.start("default:slow");
    const [second] = lifecycle.claim();
    expect(second!.attempt).toBe(2);
    await executeTask(second!, lifecycle, new AbortController().signal, () => {});

    expect(getInstance(db, id)!.state).toBe("SUCCESS");
    const text = logText(getInstance(db, id)!.log_path);
    expect(text.match(/attempt-started/g)).toHaveLength(2);
    expect(text).toContain("attempt-started");
  });

  test("timeout commits before the abort signal, so a done() from the handler loses", async () => {
    const entryPoint = addTaskFile(
      projectDir,
      "timeout",
      `export default async function(ctx) {
        ctx.signal.addEventListener("abort", () => ctx.done(0), { once: true });
        await new Promise((resolve) => setTimeout(resolve, 60));
        ctx.done(0);
      }`,
    );
    insertTaskRow(db, "default:timeout", entryPoint, { timeoutMs: 15 });
    lifecycle.syncQueues();

    const { id } = lifecycle.enqueue("default:timeout", {});
    const [claim] = lifecycle.claim();
    const controller = new AbortController();
    await executeTask(claim!, lifecycle, controller.signal, () => controller.abort());

    const instance = getInstance(db, id)!;
    expect(instance.state).toBe("FAILED");
    expect(instance.failure_reason).toBe("timeout");
    expect(instance.exit_code).toBeNull();
  });

  test("a late completion from a superseded attempt is ignored", async () => {
    const marker = join(projectDir, "first-attempt.marker");
    const entryPoint = addTaskFile(
      projectDir,
      "stale",
      `import { existsSync, writeFileSync } from "node:fs";
       export default async function(ctx) {
         const first = !existsSync(${JSON.stringify(marker)});
         if (first) {
           writeFileSync(${JSON.stringify(marker)}, "");
           await new Promise((resolve) => setTimeout(resolve, 80));
           ctx.done(1);
           return;
         }
         ctx.done(0);
       }`,
    );
    insertTaskRow(db, "default:stale", entryPoint);
    lifecycle.syncQueues();

    const { id } = lifecycle.enqueue("default:stale", {});
    const [first] = lifecycle.claim();
    const firstController = new AbortController();
    const firstRun = executeTask(
      first!,
      lifecycle,
      firstController.signal,
      () => firstController.abort(),
    );

    await waitFor(() => getInstance(db, id)!.state === "RUNNING");
    await Bun.sleep(10);
    lifecycle.abortQueue("default:stale");
    firstController.abort();

    lifecycle.start("default:stale");
    const [second] = lifecycle.claim();
    expect(second!.attempt).toBe(2);
    await executeTask(second!, lifecycle, new AbortController().signal, () => {});

    await firstRun;
    const instance = getInstance(db, id)!;
    expect(instance.state).toBe("SUCCESS");
    expect(instance.attempt).toBe(2);
  });
});

describe("runner: control requests, grace, and reload", () => {
  let dataDir: string;
  let projectDir: string;
  let db: DB;
  let lifecycle: Lifecycle;
  let core: Core;

  beforeEach(() => {
    dataDir = makeTempDir("tq-runner-");
    projectDir = makeTempDir("tq-runner-project-");
    const config = resolveDataDir(dataDir);
    bootstrapDataDir(config);
    db = openDatabase(config.dbPath);
    configureDatabase(db);
    const events = createEventBus();
    lifecycle = createLifecycle({ db, events, logDir: config.logDir });
    core = createCore({ db, lifecycle, projectRoot: projectDir, dataDir });
    installConsoleInterception();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (db) closeDatabase(db);
  });

  test("runner consumes an abort request, signals the token, and allows one retry", async () => {
    const entryPoint = addTaskFile(
      projectDir,
      "cooperative",
      `export default async function(ctx) {
        console.log("started");
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 25);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            console.log("aborted");
            resolve();
          }, { once: true });
        });
        if (!ctx.signal.aborted) ctx.done(0);
      }`,
    );
    insertTaskRow(db, "default:cooperative", entryPoint);
    lifecycle.syncQueues();

    const runner = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    const { id } = lifecycle.enqueue("default:cooperative", {});

    await runner.runOnce();
    expect(runner.activeControllerKeys()).toEqual([`${id}:1`]);
    await waitFor(() => logText(getInstance(db, id)!.log_path).includes("started"));

    const abortPromise = core.abort("default:cooperative");
    const pending = getPendingControlRequests(db, "abort");
    expect(JSON.parse(pending.at(-1)!.claim_tokens!)).toEqual([
      { instanceId: id, attempt: 1 },
    ]);
    await runner.runOnce();
    const abortResult = await abortPromise;

    expect(abortResult.queueState).toBe("STOPPED");
    expect(abortResult.cancelled).toEqual([{ instanceId: id, attempt: 1 }]);
    expect(getInstance(db, id)!.state).toBe("PENDING");
    expect(getInstance(db, id)!.attempt).toBe(2);
    expect(runner.activeControllerKeys()).toEqual([]);

    lifecycle.start("default:cooperative");
    await runner.runOnce();
    await waitFor(() => getInstance(db, id)!.state === "SUCCESS");
    expect(getInstance(db, id)!.attempt).toBe(2);
    expect(logText(getInstance(db, id)!.log_path).match(/started/g)).toHaveLength(2);
  });

  test("abort grace is bounded when a task ignores the signal", async () => {
    const entryPoint = addTaskFile(
      projectDir,
      "stubborn",
      `export default async function(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        ctx.done(0);
      }`,
    );
    insertTaskRow(db, "default:stubborn", entryPoint);
    lifecycle.syncQueues();

    const runner = createRunner({
      db,
      lifecycle,
      pollIntervalMs: 5,
      abortGraceMs: 40,
    });
    const { id } = lifecycle.enqueue("default:stubborn", {});
    await runner.runOnce();
    await waitFor(() => getInstance(db, id)!.state === "RUNNING");

    const abortPromise = core.abort("default:stubborn");
    const started = Date.now();
    await runner.runOnce();
    const result = await abortPromise;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(250);
    expect(result.cancelled).toEqual([{ instanceId: id, attempt: 1 }]);
    expect(getInstance(db, id)!.state).toBe("PENDING");
    expect(getInstance(db, id)!.attempt).toBe(2);
  });

  test("a stale abort request is discarded without changing state", async () => {
    const entryPoint = addTaskFile(
      projectDir,
      "idle",
      `export default async function(ctx) { ctx.done(0); }`,
    );
    insertTaskRow(db, "default:idle", entryPoint);
    lifecycle.syncQueues();

    const runner = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    insertControlRequest(db, "abort", "default:idle", [
      { instanceId: 999, attempt: 1 },
    ]);
    await runner.runOnce();

    expect(getInstance(db, 999)).toBeNull();
    expect(lifecycle.claim()).toEqual([]);
  });

  test("abort with nothing running still stops the queue", async () => {
    const entryPoint = addTaskFile(
      projectDir,
      "empty",
      `export default async function(ctx) { ctx.done(0); }`,
    );
    insertTaskRow(db, "default:empty", entryPoint);
    lifecycle.syncQueues();

    const runner = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    const abortPromise = core.abort("default:empty");
    await runner.runOnce();
    const result = await abortPromise;

    expect(result.queueState).toBe("STOPPED");
    expect(result.cancelled).toEqual([]);
    expect(core.getQueue("default:empty")!.state).toBe("STOPPED");
  });

  test("reload re-imports edited code and applies concurrency changes", async () => {
    const taskDir = join(projectDir, "tasks", "reloadable");
    addTaskFile(
      projectDir,
      "reloadable",
      `export default async function(ctx) { console.log("v1"); ctx.done(0); }`,
      { concurrency: 1 },
    );

    const loaded = loadAllTasks(db, projectDir, []);
    expect(loaded.loaded).toBe(1);
    lifecycle.syncQueues();

    const runner = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    const first = lifecycle.enqueue("default:reloadable", {});
    await runner.runOnce();
    await waitFor(() => getInstance(db, first.id)!.state === "SUCCESS");
    expect(logText(getInstance(db, first.id)!.log_path)).toContain("v1");

    writeFileSync(
      join(taskDir, "index.ts"),
      `export default async function(ctx) { console.log("v2"); ctx.done(0); }`,
    );
    writeFileSync(
      join(taskDir, "settings.json"),
      JSON.stringify({
        namespace: "default",
        id: "reloadable",
        name: "reloadable",
        concurrency: 3,
      }),
    );

    const reload = core.reload();
    expect(reload.loaded).toBe(1);
    expect(core.getQueue("default:reloadable")!.concurrency).toBe(3);

    const second = lifecycle.enqueue("default:reloadable", {});
    await runner.runOnce();
    await waitFor(() => getInstance(db, second.id)!.state === "SUCCESS");
    expect(logText(getInstance(db, second.id)!.log_path)).toContain("v2");
  });
});
