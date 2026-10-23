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

describe("Seam A: additional cases", () => {
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

    writeTask(join(projectDir, "tasks"), "echo", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "echo",
        name: "Echo",
        concurrency: 1,
      }),
      "index.ts": `export default async function(ctx) { console.log(JSON.stringify(ctx.input)); ctx.done(0); }`,
      "README.md": "# echo",
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

  test("enqueue before daemon start behavior works with running daemon", async () => {
    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "default:echo", input: { msg: "hi" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();
  });
});
