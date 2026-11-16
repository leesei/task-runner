import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { createLifecycle, type Lifecycle } from "../src/core/lifecycle.ts";
import { createCore } from "../src/core/service.ts";
import { CoreError } from "../src/core/errors.ts";
import { createRunner } from "../src/runner/runner.ts";
import { installConsoleInterception } from "../src/runner/execution.ts";
import { readLogFile } from "../src/db/logs.ts";
import { loadAllTasks } from "../src/tasks/discovery.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTask(
  projectDir: string,
  name: string,
  source: string,
  concurrency = 1,
): void {
  const dir = join(projectDir, "tasks", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      namespace: "default",
      id: name,
      name,
      concurrency,
      timeoutMs: 30_000,
    }),
  );
  writeFileSync(join(dir, "README.md"), `# ${name}`);
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

describe("instance working directory", () => {
  let dataDir: string;
  let projectDir: string;
  let db: DB;
  let lifecycle: Lifecycle;
  let core: ReturnType<typeof createCore>;

  beforeEach(() => {
    dataDir = makeTempDir("tq-cwd-");
    projectDir = makeTempDir("tq-cwd-project-");
    const config = resolveDataDir(dataDir);
    bootstrapDataDir(config);
    db = openDatabase(config.dbPath);
    configureDatabase(db);
    lifecycle = createLifecycle({
      db,
      events: createEventBus(),
      logDir: config.logDir,
      defaultCwd: projectDir,
    });
    core = createCore({ db, lifecycle, projectRoot: projectDir, dataDir });
    installConsoleInterception();
  });

  afterEach(() => {
    try {
      closeDatabase(db);
    } catch {}
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function loadEchoTask(): void {
    writeTask(
      projectDir,
      "echo-cwd",
      `export default async function(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        console.log(ctx.cwd);
        ctx.done(0);
      }`,
    );
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();
  }

  test("enqueue stores the supplied absolute working directory", () => {
    loadEchoTask();
    const cwd = makeTempDir("tq-cwd-target-");

    const result = core.enqueue("default:echo-cwd", {}, { cwd });

    expect(result.cwd).toBe(cwd);
    expect(core.getInstance(result.id)!.cwd).toBe(cwd);
  });

  test("enqueue defaults to the core project root", () => {
    loadEchoTask();

    const result = core.enqueue("default:echo-cwd", {});

    expect(result.cwd).toBe(projectDir);
    expect(core.getInstance(result.id)!.cwd).toBe(projectDir);
  });

  test("the task observes ctx.cwd, not the runner process directory", async () => {
    loadEchoTask();
    const cwd = makeTempDir("tq-cwd-target-");
    const runner = createRunner({ db, lifecycle, pollIntervalMs: 5 });

    const result = core.enqueue("default:echo-cwd", {}, { cwd });
    await runner.runOnce();
    await waitFor(() => core.getInstance(result.id)!.state === "SUCCESS");

    const log = logText(core.getInstance(result.id)!.log_path);
    expect(log).toContain(cwd);
    expect(log).not.toContain(process.cwd());
  });

  test("rejects relative, missing, and non-directory cwd without creating an instance", () => {
    loadEchoTask();
    const file = join(makeTempDir("tq-cwd-file-"), "not-a-dir");
    writeFileSync(file, "");

    const cases = [
      "relative/path",
      join(projectDir, "does-not-exist"),
      file,
    ];

    for (const cwd of cases) {
      let error: unknown;
      try {
        core.enqueue("default:echo-cwd", {}, { cwd });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("INVALID_CWD");
    }

    expect(core.listInstances("default:echo-cwd")).toEqual([]);
  });

  test("a legacy row without cwd falls back to the lifecycle default", () => {
    loadEchoTask();
    const result = core.enqueue("default:echo-cwd", {});
    db.run("UPDATE instances SET cwd = NULL WHERE id = ?", [result.id]);

    const [claim] = lifecycle.claim();
    expect(claim!.cwd).toBe(projectDir);
  });

  test("a missing directory at execution time fails explicitly and does not run the task", async () => {
    const marker = join(projectDir, "task-ran.marker");
    writeTask(
      projectDir,
      "needs-dir",
      `import { writeFileSync } from "node:fs";
       export default async function(ctx) {
         writeFileSync(${JSON.stringify(marker)}, "");
         ctx.done(0);
       }`,
    );
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    const cwd = makeTempDir("tq-cwd-gone-");
    const runner = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    const result = core.enqueue("default:needs-dir", {}, { cwd });
    rmSync(cwd, { recursive: true, force: true });

    await runner.runOnce();
    await waitFor(() => core.getInstance(result.id)!.state === "FAILED");

    const instance = core.getInstance(result.id)!;
    expect(instance.failure_reason).toBe("cwd_not_found");
    expect(instance.exit_code).toBe(1);
    expect(logText(instance.log_path)).toContain("working directory not available");
    expect(existsSync(marker)).toBe(false);
  });

  test("working directory survives closing and reopening the database", () => {
    loadEchoTask();
    const cwd = makeTempDir("tq-cwd-target-");
    const result = core.enqueue("default:echo-cwd", {}, { cwd });

    closeDatabase(db);
    const config = resolveDataDir(dataDir);
    db = openDatabase(config.dbPath);
    configureDatabase(db);
    lifecycle = createLifecycle({
      db,
      events: createEventBus(),
      logDir: config.logDir,
      defaultCwd: projectDir,
    });

    const [claim] = lifecycle.claim();
    expect(claim!.instanceId).toBe(result.id);
    expect(claim!.cwd).toBe(cwd);
  });

  test("abort and retry preserve the working directory", () => {
    loadEchoTask();
    const cwd = makeTempDir("tq-cwd-target-");
    const result = core.enqueue("default:echo-cwd", {}, { cwd });

    const [first] = lifecycle.claim();
    expect(first!.cwd).toBe(cwd);
    lifecycle.abortQueue("default:echo-cwd");
    lifecycle.start("default:echo-cwd");

    const [second] = lifecycle.claim();
    expect(second!.attempt).toBe(2);
    expect(second!.cwd).toBe(cwd);
    expect(second!.instanceId).toBe(result.id);
  });

  test("concurrent instances with different directories each see their own cwd", async () => {
    writeTask(
      projectDir,
      "echo-a",
      `export default async function(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        console.log(ctx.cwd);
        ctx.done(0);
      }`,
    );
    writeTask(
      projectDir,
      "echo-b",
      `export default async function(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        console.log(ctx.cwd);
        ctx.done(0);
      }`,
    );
    loadAllTasks(db, projectDir, []);
    core.syncQueues();
    core.recoverOnBoot();

    const dirA = makeTempDir("tq-cwd-a-");
    const dirB = makeTempDir("tq-cwd-b-");
    const runner = createRunner({ db, lifecycle, pollIntervalMs: 5 });
    const before = process.cwd();

    const a = core.enqueue("default:echo-a", {}, { cwd: dirA });
    const b = core.enqueue("default:echo-b", {}, { cwd: dirB });

    await runner.runOnce();
    await waitFor(
      () =>
        core.getInstance(a.id)!.state === "SUCCESS" &&
        core.getInstance(b.id)!.state === "SUCCESS",
    );

    const logA = logText(core.getInstance(a.id)!.log_path);
    const logB = logText(core.getInstance(b.id)!.log_path);
    expect(logA).toContain(dirA);
    expect(logA).not.toContain(dirB);
    expect(logB).toContain(dirB);
    expect(logB).not.toContain(dirA);
    expect(process.cwd()).toBe(before);
  });
});
