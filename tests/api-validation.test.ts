import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createApi } from "../src/api/index.ts";
import { createHarness, type TestHarness } from "./support/harness.ts";
import {
  bootstrapDataDir,
  closeDatabase,
  configureDatabase,
  openDatabase,
  resolveDataDir,
} from "../src/db/database.ts";
import { getInstancesByQueue } from "../src/db/queries.ts";
import { loadAllTasks } from "../src/tasks/discovery.ts";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tq-api-validation-test-"));
}

function writeTask(dir: string, name: string, files: Record<string, string>) {
  const taskDir = join(dir, name);
  mkdirSync(taskDir, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    writeFileSync(join(taskDir, k), v);
  }
}

const SCHEMA = {
  type: "object",
  required: ["filepath"],
  properties: {
    filepath: { type: "string", format: "path" },
    count: { type: "integer", minimum: 1 },
  },
};

describe("Seam C: HTTP enqueue validation parity", () => {
  let dataDir: string;
  let projectDir: string;
  let db: ReturnType<typeof openDatabase>;
  let api: (req: Request) => Promise<Response>;
  let harness: TestHarness;

  beforeAll(() => {
    dataDir = makeTempDir();
    projectDir = makeTempDir();
    bootstrapDataDir(resolveDataDir(dataDir));
    db = openDatabase(resolveDataDir(dataDir).dbPath);
    configureDatabase(db);

    writeTask(join(projectDir, "tasks"), "validated", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "validated",
        name: "Validated task",
        inputSchema: "schema.json",
      }),
      "schema.json": JSON.stringify(SCHEMA),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# validated",
    });
    loadAllTasks(db, projectDir, []);
    harness = createHarness(db, dataDir, projectDir);
    api = createApi({ core: harness.core, events: harness.events, dataDir, cwd: projectDir });
  });

  afterAll(() => {
    closeDatabase(db);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function post(body: unknown): Promise<Response> {
    return api(
      new Request("http://localhost/api/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  test("valid context is accepted", async () => {
    const res = await post({
      task: "default:validated",
      input: { filepath: "/abs/file", count: 2 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBeDefined();
  });

  test("schema violation returns 400 INPUT_SCHEMA_VIOLATION with issues", async () => {
    const before = getInstancesByQueue(db, "default:validated").length;
    const res = await post({
      task: "default:validated",
      input: { count: 0 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("INPUT_SCHEMA_VIOLATION");
    expect(body.message).toContain("default:validated");
    const paths = body.issues.map((issue: { path: string }) => issue.path);
    expect(paths).toContain("/filepath");
    expect(paths).toContain("/count");
    expect(getInstancesByQueue(db, "default:validated").length).toBe(before);
  });

  test("HTTP and core reject the same context with the same issue paths", async () => {
    const input = { count: 0, filepath: 7 };

    let coreIssues: { path: string; message: string }[] = [];
    try {
      harness.core.enqueue("default:validated", input);
    } catch (err: any) {
      coreIssues = err.issues;
    }

    const res = await post({ task: "default:validated", input });
    const body = (await res.json()) as any;
    expect(
      body.issues.map((i: { path: string }) => i.path).sort(),
    ).toEqual(coreIssues.map((i) => i.path).sort());
  });

  test("unknown task returns 404 TASK_NOT_FOUND", async () => {
    const res = await post({ task: "nope:nope", input: {} });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe("TASK_NOT_FOUND");
  });
});
