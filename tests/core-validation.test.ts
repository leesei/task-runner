import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CoreError } from "../src/core/service.ts";
import { createHarness, type TestHarness } from "./support/harness.ts";
import {
  bootstrapDataDir,
  closeDatabase,
  configureDatabase,
  openDatabase,
  resolveDataDir,
} from "../src/db/database.ts";
import { getInstance, getInstancesByQueue } from "../src/db/queries.ts";
import { loadAllTasks } from "../src/tasks/discovery.ts";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tq-validation-test-"));
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
  required: ["filepath", "count"],
  properties: {
    filepath: { type: "string", format: "path", description: "File to inspect" },
    count: { type: "integer", minimum: 1, maximum: 5 },
    mode: { type: "string", enum: ["fast", "slow"] },
    verbose: { type: "boolean", default: false },
  },
  // Unknown keywords must be ignored, not rejected.
  "x-task-runner-note": { internal: true },
};

describe("Seam A: core enqueue validation", () => {
  let dataDir: string;
  let projectDir: string;
  let db: ReturnType<typeof openDatabase>;
  let harness: TestHarness;

  beforeAll(() => {
    dataDir = makeTempDir();
    projectDir = makeTempDir();

    const dbConfig = resolveDataDir(dataDir);
    bootstrapDataDir(dbConfig);
    db = openDatabase(dbConfig.dbPath);
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
    writeTask(join(projectDir, "tasks"), "noschema", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "noschema",
        name: "No schema task",
      }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# noschema",
    });

    loadAllTasks(db, projectDir, []);
    harness = createHarness(db, dataDir, projectDir);
  });

  afterAll(() => {
    if (db) closeDatabase(db);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("accepts context matching the schema and applies defaults", () => {
    const input = { filepath: "/tmp/a", count: 2, mode: "fast" };
    const { id } = harness.core.enqueue("default:validated", input);

    const stored = getInstance(db, id)!;
    expect(JSON.parse(stored.input)).toEqual({
      filepath: "/tmp/a",
      count: 2,
      mode: "fast",
      verbose: false,
    });
    // The caller's object is not mutated by default application.
    expect(input).toEqual({ filepath: "/tmp/a", count: 2, mode: "fast" });
  });

  test("rejects a missing required property without creating an instance", () => {
    const before = getInstancesByQueue(db, "default:validated").length;

    let caught: unknown;
    try {
      harness.core.enqueue("default:validated", { count: 1 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CoreError);
    const err = caught as CoreError;
    expect(err.code).toBe("INPUT_SCHEMA_VIOLATION");
    expect(err.issues).toEqual([
      expect.objectContaining({ path: "/filepath" }),
    ]);
    expect(err.issues![0]!.message).toContain("required property");
    expect(getInstancesByQueue(db, "default:validated").length).toBe(before);
  });

  test("reports type, enum, and maximum violations with field paths", () => {
    let caught: unknown;
    try {
      harness.core.enqueue("default:validated", {
        filepath: 42,
        count: 9,
        mode: "turbo",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CoreError);
    const err = caught as CoreError;
    expect(err.code).toBe("INPUT_SCHEMA_VIOLATION");
    const paths = err.issues!.map((issue) => issue.path);
    expect(paths).toContain("/filepath");
    expect(paths).toContain("/count");
    expect(paths).toContain("/mode");
    const countIssue = err.issues!.find((issue) => issue.path === "/count")!;
    expect(countIssue.message).toContain("<= 5");
  });

  test("rejects a value below the minimum", () => {
    let caught: unknown;
    try {
      harness.core.enqueue("default:validated", { filepath: "/tmp/a", count: 0 });
    } catch (err) {
      caught = err;
    }
    const err = caught as CoreError;
    expect(err.code).toBe("INPUT_SCHEMA_VIOLATION");
    expect(err.issues).toEqual([expect.objectContaining({ path: "/count" })]);
    expect(err.issues![0]!.message).toContain(">= 1");
  });

  test("accepts arbitrary context for a schema-less task", () => {
    const value = { anything: ["goes", 1, null, true] };
    const { id } = harness.core.enqueue("default:noschema", value);
    expect(JSON.parse(getInstance(db, id)!.input)).toEqual(value);
  });

  test("unknown task still fails with TASK_NOT_FOUND", () => {
    expect(() => harness.core.enqueue("nope:nope", {})).toThrow(CoreError);
  });
});
