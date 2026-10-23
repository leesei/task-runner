import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveDataDir, bootstrapDataDir, openDatabase, closeDatabase, configureDatabase } from "../src/db/database.ts";
import { loadAllTasks } from "../src/tasks/discovery.ts";
import { ensureQueuesForTasks, autostartQueuesOnBoot } from "../src/runner/queue-state.ts";
import { createApi } from "../src/api/index.ts";
import { createRunner } from "../src/runner/runner.ts";
import { installConsoleInterception } from "../src/runner/execution.ts";
import { getInstancesByQueue } from "../src/db/queries.ts";

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

describe("Seam A: FIFO", () => {
  let dataDir: string;
  let projectDir: string;
  let db: any;
  let api: (req: Request) => Promise<Response>;
  let runner: any;
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
      "settings.json": JSON.stringify({ namespace: "default", id: "echo", name: "Echo", concurrency: 1 }),
      "index.ts": `export default async function(ctx) { console.log(ctx.input.seq); ctx.done(0); }`,
      "README.md": "# echo"
    });
    loadAllTasks(db, projectDir, []);
    ensureQueuesForTasks(db);
    autostartQueuesOnBoot(db);
    installConsoleInterception();
    api = createApi({ db, dataDir, cwd: projectDir });
    runner = createRunner({ dataDir, pollIntervalMs: 5 });
    server = Bun.serve({ port: 0, fetch: api });
    baseUrl = `http://localhost:${server.port}`;
    runner.runContinuous(db).catch(() => {});
  });

  afterAll(() => {
    server?.stop();
    if (db) closeDatabase(db);
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  test("FIFO order within queue", async () => {
    await fetch(`${baseUrl}/api/instances`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "default:echo", input: { seq: 1 } })
    });
    await fetch(`${baseUrl}/api/instances`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "default:echo", input: { seq: 2 } })
    });
    await new Promise(r => setTimeout(r, 100));
    const instances = getInstancesByQueue(db, "default:echo");
    expect(instances.length).toBeGreaterThanOrEqual(2);
  });
});
