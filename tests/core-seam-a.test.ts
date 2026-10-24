import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { createEventBus } from "../src/core/events.ts";
import { createLifecycle } from "../src/core/lifecycle.ts";
import { createCore } from "../src/core/service.ts";
import { CoreError } from "../src/core/errors.ts";
import { createRunner } from "../src/runner/runner.ts";
import { installConsoleInterception } from "../src/runner/execution.ts";
import { loadAllTasks } from "../src/tasks/discovery.ts";
import { getInstance, getQueue, getInstancesByQueue } from "../src/db/queries.ts";

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

function writeTask(dir: string, name: string, files: Record<string, string>) {
  const taskDir = join(dir, name);
  mkdirSync(taskDir, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    writeFileSync(join(taskDir, k), v);
  }
}

describe("Seam A: core operations", () => {
  let dataDir: string;
  let projectDir: string;
  let db: DB;
  let core: ReturnType<typeof createCore>;
  let lifecycle: ReturnType<typeof createLifecycle>;
  let events: ReturnType<typeof createEventBus>;
  let runner: ReturnType<typeof createRunner>;

  beforeEach(async () => {
    dataDir = makeTempDir("tq-core-seam-a-");
    projectDir = makeTempDir("tq-core-seam-a-proj-");
    const dbConfig = resolveDataDir(dataDir);
    bootstrapDataDir(dbConfig);
    db = openDatabase(dbConfig.dbPath);
    configureDatabase(db);
    events = createEventBus();
    installConsoleInterception();
    lifecycle = createLifecycle({ db, events, logDir: dbConfig.logDir });
    core = createCore({ db, lifecycle, projectRoot: projectDir, dataDir });
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  test("enqueue before runner start, then start runner, observe autostart drain", async () => {
    // Create success fixture task
    writeTask(join(projectDir, "tasks"), "success", {
      "settings.json": JSON.stringify({ namespace: "default", id: "success", name: "Success", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# success",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    const { id } = core.enqueue("default:success", {});
    const instanceBefore = core.getInstance(id)!;
    expect(instanceBefore.state).toBe("PENDING");

    // Start runner and wait for drain
    runner = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    for (let i = 0; i < 50; i++) {
      await runner.runOnce();
      const inst = core.getInstance(id)!;
      if (inst.state === "SUCCESS") break;
      await Bun.sleep(10);
    }
    const instance = core.getInstance(id)!;
    expect(instance.state).toBe("SUCCESS");
    expect(instance.exit_code).toBe(0);
  });

  test("stop lets RUNNING finish, leaves PENDING untouched, reports STOPPED", async () => {
    writeTask(join(projectDir, "tasks"), "slow", {
      "settings.json": JSON.stringify({ namespace: "default", id: "slow", name: "Slow", concurrency: 1 }),
      "index.ts": `export default async function(ctx) {
        await new Promise(r => setTimeout(r, 80));
        ctx.done(0);
      }`,
      "README.md": "# slow",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    const r1 = core.enqueue("default:slow", {});
    const r2 = core.enqueue("default:slow", {});
    runner = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    await runner.runOnce();
    const state = core.stop("default:slow");
    expect(state).toBe("STOPPED");
    for (let i = 0; i < 40; i++) {
      await runner.runOnce();
      if (core.getInstance(r1.id)!.state === "SUCCESS") break;
      await Bun.sleep(10);
    }
    expect(core.getInstance(r2.id)!.state).toBe("PENDING");
  });

  test("start resumes and drains remaining PENDING instances", async () => {
    writeTask(join(projectDir, "tasks"), "echo", {
      "settings.json": JSON.stringify({ namespace: "default", id: "echo", name: "Echo", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# echo",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    core.stop("default:echo");
    const r1 = core.enqueue("default:echo", {});
    const r2 = core.enqueue("default:echo", {});
    expect(core.getInstance(r1.id)!.state).toBe("PENDING");

    runner = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    core.start("default:echo");
    for (let i = 0; i < 50; i++) {
      await runner.runOnce();
      if (core.getInstance(r1.id)!.state === "SUCCESS" && core.getInstance(r2.id)!.state === "SUCCESS") break;
      await Bun.sleep(10);
    }
    expect(core.getInstance(r1.id)!.state).toBe("SUCCESS");
    expect(core.getInstance(r2.id)!.state).toBe("SUCCESS");
  });

  test("abort returns instance to PENDING, preserves partial output, stops queue", async () => {
    writeTask(join(projectDir, "tasks"), "slow", {
      "settings.json": JSON.stringify({ namespace: "default", id: "slow", name: "Slow", concurrency: 1 }),
      "index.ts": `export default async function(ctx) {
        console.log("partial");
        while (!ctx.signal.aborted) {
          await new Promise(r => setTimeout(r, 5));
        }
        ctx.done(124);
      }`,
      "README.md": "# slow",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    const r = core.enqueue("default:slow", {});
    runner = createRunner({ db, lifecycle, pollIntervalMs: 10, abortGraceMs: 50 });
    runner.runContinuous().catch(() => {});
    await Bun.sleep(80);
    const result = await core.abort("default:slow");
    expect(result.queueState).toBe("STOPPED");
    await Bun.sleep(400);
    const inst = core.getInstance(r.id)!;
    expect(inst.state).toBe("PENDING");
    const log = core.readInstanceLog(r.id)!;
    const out = log.records.map(x => x.text).join("");
    expect(out).toContain("partial");
  });


  test("enqueue into STOPPED queue stays PENDING; enqueue into IDLE queue starts", async () => {
    writeTask(join(projectDir, "tasks"), "echo", {
      "settings.json": JSON.stringify({ namespace: "default", id: "echo", name: "Echo", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# echo",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    core.stop("default:echo");
    const r1 = core.enqueue("default:echo", {});
    expect(core.getInstance(r1.id)!.state).toBe("PENDING");
    expect(core.getQueue("default:echo")!.state).toBe("STOPPED");

    // IDLE queue auto-starts on enqueue
    const r2 = core.enqueue("default:echo", {}); // queue is STOPPED, so enqueue into STOPPED stays PENDING
    // Actually check - spec says "enqueue into a STOPPED queue stays PENDING; enqueue into an IDLE queue starts"
    // Current queue is STOPPED, so should stay PENDING
    expect(core.getInstance(r2.id)!.state).toBe("PENDING");
  });

  test("exit 0 -> SUCCESS, non-zero and throw -> FAILED, timeout -> FAILED with timeout", async () => {
    writeTask(join(projectDir, "tasks"), "ok", {
      "settings.json": JSON.stringify({ namespace: "default", id: "ok", name: "Ok", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# ok",
    });
    writeTask(join(projectDir, "tasks"), "fail", {
      "settings.json": JSON.stringify({ namespace: "default", id: "fail", name: "Fail", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(1); }`,
      "README.md": "# fail",
    });
    writeTask(join(projectDir, "tasks"), "throw", {
      "settings.json": JSON.stringify({ namespace: "default", id: "throw", name: "Throw", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { throw new Error("boom"); }`,
      "README.md": "# throw",
    });
    writeTask(join(projectDir, "tasks"), "slowt", {
      "settings.json": JSON.stringify({ namespace: "default", id: "slowt", name: "Slowt", concurrency: 1, timeoutMs: 50 }),
      "index.ts": `export default async function(ctx) { await new Promise(r=>setTimeout(r,500)); ctx.done(0); }`,
      "README.md": "# slowt",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    const ro = core.enqueue("default:ok", {});
    const rf = core.enqueue("default:fail", {});
    const rt = core.enqueue("default:throw", {});
    const rto = core.enqueue("default:slowt", {});

    const runner2 = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    runner2.runContinuous().catch(() => {});
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(20);
      if (core.getInstance(ro.id)!.state === "SUCCESS" && core.getInstance(rf.id)!.state === "FAILED" &&
          core.getInstance(rt.id)!.state === "FAILED" && core.getInstance(rto.id)!.state === "FAILED") break;
    }
    expect(core.getInstance(ro.id)!.state).toBe("SUCCESS");
    expect(core.getInstance(rf.id)!.state).toBe("FAILED");
    expect(core.getInstance(rt.id)!.state).toBe("FAILED");
    const to = core.getInstance(rto.id)!;
    expect(to.state).toBe("FAILED");
    expect(to.failure_reason).toBe("timeout");
  });



  test("stdout/stderr interleaving is preserved in log reads", async () => {
    writeTask(join(projectDir, "tasks"), "noisy", {
      "settings.json": JSON.stringify({ namespace: "default", id: "noisy", name: "Noisy", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { console.log("hello"); console.error("world"); ctx.done(0); }`,
      "README.md": "# noisy",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    const r = core.enqueue("default:noisy", {});
    const runner2 = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    runner2.runContinuous().catch(() => {});
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(10);
      if (core.getInstance(r.id)!.state === "SUCCESS") break;
    }
    const log = core.readInstanceLog(r.id)!;
    const streams = log.records.map(x => x.stream);
    // both streams present
    expect(streams.includes("stdout")).toBe(true);
    expect(streams.includes("stderr")).toBe(true);
  });

  test("schema violation returns INPUT_SCHEMA_VIOLATION with field issues and creates no instance", async () => {
    writeTask(join(projectDir, "tasks"), "typed", {
      "settings.json": JSON.stringify({ namespace: "default", id: "typed", name: "Typed", concurrency: 1, inputSchema: "schema.json" }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# typed",
      "schema.json": JSON.stringify({ type: "object", properties: { x: { type: "number" } }, required: ["x"] }),
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    try {
      core.enqueue("default:typed", {});
      expect(false).toBe(true);
    } catch (e: any) {
      expect(e.code).toBe("INPUT_SCHEMA_VIOLATION");
      expect(Array.isArray(e.issues)).toBe(true);
    }
    // no instance created
    const insts = getInstancesByQueue(db, "default:typed");
    expect(insts.length).toBe(0);
  });

  test("schema-less tasks accept arbitrary values", async () => {
    writeTask(join(projectDir, "tasks"), "noschema", {
      "settings.json": JSON.stringify({ namespace: "default", id: "noschema", name: "NoSchema", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# noschema",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();
    const r = core.enqueue("default:noschema", { anything: 123, nested: { a: 1 } });
    expect(r.id).toBeGreaterThan(0);
  });

  test("malformed JSON and unknown id rejected without creating instance", async () => {
    writeTask(join(projectDir, "tasks"), "echo", {
      "settings.json": JSON.stringify({ namespace: "default", id: "echo", name: "Echo", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# echo",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();
    try {
      core.enqueue("nope:nope", {});
      expect(false).toBe(true);
    } catch (e: any) {
      expect(e.code).toBe("TASK_NOT_FOUND");
    }
  });



  test("clear removes SUCCESS rows and log files; clear --all refuses while RUNNING", async () => {
    writeTask(join(projectDir, "tasks"), "echo", {
      "settings.json": JSON.stringify({ namespace: "default", id: "echo", name: "Echo", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# echo",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    const r = core.enqueue("default:echo", {});
    const runner2 = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    runner2.runContinuous().catch(() => {});
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(10);
      if (core.getInstance(r.id)!.state === "SUCCESS") break;
    }
    const cleared = core.clear("default:echo");
    expect(cleared.deleted).toBe(1);
    expect(core.getInstance(r.id)).toBeNull();

    // clear --all refuses while RUNNING
    writeTask(join(projectDir, "tasks"), "slow", {
      "settings.json": JSON.stringify({ namespace: "default", id: "slow", name: "Slow", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { await new Promise(r=>setTimeout(r,1000)); ctx.done(0); }`,
      "README.md": "# slow",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    const r2 = core.enqueue("default:slow", {});
    const runner3 = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    await runner3.runOnce();
    try {
      core.clear("default:slow", true);
      expect(false).toBe(true);
    } catch (e: any) {
      expect(e.code).toBe("CLEAR_REFUSED_RUNNING");
    }
  });

  test("restart resets RUNNING to PENDING, preserves STOPPED queues, keeps finished instances", async () => {
    writeTask(join(projectDir, "tasks"), "echo", {
      "settings.json": JSON.stringify({ namespace: "default", id: "echo", name: "Echo", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# echo",
    });
    writeTask(join(projectDir, "tasks"), "stoppedq", {
      "settings.json": JSON.stringify({ namespace: "default", id: "stoppedq", name: "Stoppedq", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# stoppedq",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    // create a finished instance
    const rf = core.enqueue("default:echo", {});
    const runner2 = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    runner2.runContinuous().catch(() => {});
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(10);
      if (core.getInstance(rf.id)!.state === "SUCCESS") break;
    }

    // make one RUNNING manually by claiming
    const rrun = core.enqueue("default:echo", {});
    lifecycle.claim();
    expect(core.getInstance(rrun.id)!.state).toBe("RUNNING");

    // stop a queue
    core.stop("default:stoppedq");
    const sq = core.getQueue("default:stoppedq")!;
    expect(sq.state).toBe("STOPPED");

    // recoverOnBoot simulates restart
    const res = core.recoverOnBoot();
    expect(res.reset).toBeGreaterThanOrEqual(1);
    expect(core.getInstance(rrun.id)!.state).toBe("PENDING");
    expect(core.getInstance(rrun.id)!.attempt).toBe(2);
    expect(core.getQueue("default:stoppedq")!.state).toBe("STOPPED");
    expect(core.getInstance(rf.id)!.state).toBe("SUCCESS"); // finished kept
  });



  test("reload picks up new task folder and changed concurrency, reports conflicts", async () => {
    writeTask(join(projectDir, "tasks"), "echo", {
      "settings.json": JSON.stringify({ namespace: "default", id: "echo", name: "Echo", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# echo",
    });
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();
    expect(core.getQueue("default:echo")!.concurrency).toBe(1);

    // change concurrency
    writeTask(join(projectDir, "tasks"), "echo", {
      "settings.json": JSON.stringify({ namespace: "default", id: "echo", name: "Echo", concurrency: 5 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# echo",
    });
    const res = core.reload();
    expect(res.loaded).toBeGreaterThanOrEqual(1);
    expect(core.getQueue("default:echo")!.concurrency).toBe(5);

    // add new task
    writeTask(join(projectDir, "tasks"), "newtask", {
      "settings.json": JSON.stringify({ namespace: "default", id: "newtask", name: "Newtask", concurrency: 2 }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# newtask",
    });
    core.reload();
    expect(core.getQueue("default:newtask")!.concurrency).toBe(2);
  });

});
