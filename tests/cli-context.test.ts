import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildContext, resolveContextPaths, UsageError } from "../src/cli/context.ts";
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
  return mkdtempSync(join(tmpdir(), "tq-cli-context-test-"));
}

function writeTask(dir: string, name: string, files: Record<string, string>) {
  const taskDir = join(dir, name);
  mkdirSync(taskDir, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    writeFileSync(join(taskDir, k), v);
  }
}

const PATH_SCHEMA = {
  type: "object",
  required: ["filepath"],
  properties: {
    filepath: { type: "string", format: "path" },
    count: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: ["fast", "slow"] },
    verbose: { type: "boolean", default: false },
  },
};

const FILES_SCHEMA = {
  type: "object",
  required: ["files"],
  properties: {
    files: {
      type: "array",
      items: { type: "string", format: "path" },
    },
  },
};

const BARE_SCHEMA = {
  type: "object",
  required: ["filepath"],
  properties: { filepath: { type: "string" } },
};

describe("CLI context grammar", () => {
  test("single JSON argument is parsed", () => {
    const input = buildContext(['{"filepath":"fixture/1"}'], {
      schema: PATH_SCHEMA,
      cwd: "/work/project",
    });
    expect(input).toEqual({ filepath: "/work/project/fixture/1" });
  });

  test("@file reads JSON relative to the invocation directory", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "context.json"), JSON.stringify({ filepath: "fixture/1" }));
    try {
      const input = buildContext(["@context.json"], {
        schema: PATH_SCHEMA,
        cwd: dir,
      });
      expect(input).toEqual({ filepath: join(dir, "fixture/1") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("name=value pairs merge, later wins, and stay strings", () => {
    const input = buildContext(
      ["filepath=first", "count=2", "filepath=second"],
      { schema: PATH_SCHEMA, cwd: "/work/project" },
    );
    expect(input).toEqual({
      filepath: "/work/project/second",
      count: "2",
    });
  });

  test("name:=value parses JSON values", () => {
    const input = buildContext(
      ["count:=3", "verbose:=true", "mode:=null", "filepath:={\"nested\":[1,2]}"],
      { schema: null, cwd: "/work/project" },
    );
    expect(input).toEqual({
      count: 3,
      verbose: true,
      mode: null,
      filepath: { nested: [1, 2] },
    });
  });

  test("mixing assignments with JSON is a usage error", () => {
    expect(() =>
      buildContext(['{"filepath":"a"}', "count=2"], {
        schema: PATH_SCHEMA,
        cwd: "/work/project",
      }),
    ).toThrow(UsageError);
  });

  test("mixing assignments with a bare string is a usage error", () => {
    expect(() =>
      buildContext(["fixture/1", "count=2"], {
        schema: BARE_SCHEMA,
        cwd: "/work/project",
      }),
    ).toThrow(UsageError);
  });

  test("malformed JSON is a usage error", () => {
    expect(() =>
      buildContext(["{bad"], { schema: PATH_SCHEMA, cwd: "/work/project" }),
    ).toThrow(UsageError);
  });

  test("unreadable @file is a usage error", () => {
    expect(() =>
      buildContext(["@missing.json"], {
        schema: PATH_SCHEMA,
        cwd: "/work/project",
      }),
    ).toThrow(UsageError);
  });

  test("invalid name:=value JSON is a usage error", () => {
    expect(() =>
      buildContext(["count:=nope"], { schema: PATH_SCHEMA, cwd: "/work/project" }),
    ).toThrow(UsageError);
  });

  test("bare string with a single-required-string schema is wrapped", () => {
    const input = buildContext(["fixture/1"], {
      schema: BARE_SCHEMA,
      cwd: "/work/project",
    });
    expect(input).toEqual({ filepath: "fixture/1" });
  });

  test("bare string wrapping also resolves path properties", () => {
    const input = buildContext(["fixture/1"], {
      schema: {
        type: "object",
        required: ["filepath"],
        properties: { filepath: { type: "string", format: "path" } },
      },
      cwd: "/work/project",
    });
    expect(input).toEqual({ filepath: "/work/project/fixture/1" });
  });

  test("bare string with no schema stays a JSON string", () => {
    const input = buildContext(["fixture/1"], {
      schema: null,
      cwd: "/work/project",
    });
    expect(input).toBe("fixture/1");
  });

  test("bare string with any other schema is a usage error", () => {
    const twoRequired = {
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "string" }, b: { type: "string" } },
    };
    expect(() =>
      buildContext(["value"], { schema: twoRequired, cwd: "/work/project" }),
    ).toThrow(UsageError);

    const nonString = {
      type: "object",
      required: ["count"],
      properties: { count: { type: "integer" } },
    };
    expect(() =>
      buildContext(["5"], { schema: nonString, cwd: "/work/project" }),
    ).toThrow(UsageError);
  });

  test("relative path values resolve and absolute values are unchanged", () => {
    const input = resolveContextPaths(
      { filepath: "/already/absolute", other: "not-a-path" },
      PATH_SCHEMA,
      "/work/project",
    );
    expect(input).toEqual({
      filepath: "/already/absolute",
      other: "not-a-path",
    });

    const relative = resolveContextPaths(
      { filepath: "fixture/1" },
      PATH_SCHEMA,
      "/work/project",
    );
    expect(relative).toEqual({ filepath: "/work/project/fixture/1" });
  });

  test("path arrays resolve every element", () => {
    const input = resolveContextPaths(
      { files: ["a.txt", "/abs/b.txt", "../c.txt"] },
      FILES_SCHEMA,
      "/work/project",
    );
    expect(input).toEqual({
      files: [
        "/work/project/a.txt",
        "/abs/b.txt",
        "/work/c.txt",
      ],
    });
  });
});

describe("Seam B: tq add context sources and validation", () => {
  const CLI = join(process.cwd(), "src", "cli", "index.ts");
  let dataDir: string;
  let projectDir: string;

  beforeAll(() => {
    dataDir = makeTempDir();
    projectDir = makeTempDir();

    const dbConfig = resolveDataDir(dataDir);
    bootstrapDataDir(dbConfig);
    const db = openDatabase(dbConfig.dbPath);
    configureDatabase(db);

    writeTask(join(projectDir, "tasks"), "path-task", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "path-task",
        name: "Path task",
        inputSchema: "schema.json",
      }),
      "schema.json": JSON.stringify(PATH_SCHEMA),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# path task",
    });
    writeTask(join(projectDir, "tasks"), "files-task", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "files-task",
        name: "Files task",
        inputSchema: "schema.json",
      }),
      "schema.json": JSON.stringify(FILES_SCHEMA),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# files task",
    });
    writeTask(join(projectDir, "tasks"), "bare-task", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "bare-task",
        name: "Bare task",
        inputSchema: "schema.json",
      }),
      "schema.json": JSON.stringify(BARE_SCHEMA),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# bare task",
    });
    writeTask(join(projectDir, "tasks"), "noschema-task", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "noschema-task",
        name: "No schema task",
      }),
      "index.ts": `export default async function(ctx) { ctx.done(0); }`,
      "README.md": "# no schema task",
    });

    loadAllTasks(db, projectDir, []);
    closeDatabase(db);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  async function runCli(args: string[], cwd = projectDir) {
    const proc = Bun.spawn(
      [process.execPath, CLI, "--data-dir", dataDir, ...args],
      {
        cwd,
        env: { ...process.env, TQ_DATA_DIR: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  }

  function latestInput(taskId: string): unknown {
    const db = openDatabase(resolveDataDir(dataDir).dbPath);
    try {
      const rows = getInstancesByQueue(db, taskId);
      expect(rows.length).toBeGreaterThan(0);
      return JSON.parse(rows[0]!.input);
    } finally {
      closeDatabase(db);
    }
  }

  function instanceCount(taskId: string): number {
    const db = openDatabase(resolveDataDir(dataDir).dbPath);
    try {
      return getInstancesByQueue(db, taskId).length;
    } finally {
      closeDatabase(db);
    }
  }

  test("relative paths are resolved against the invocation directory before storage", async () => {
    const result = await runCli([
      "add",
      "default:path-task",
      '{"filepath":"fixture/1","count":2}',
    ]);
    expect(result.exitCode).toBe(0);
    expect(latestInput("default:path-task")).toEqual({
      filepath: join(projectDir, "fixture/1"),
      count: 2,
      verbose: false,
    });
  });

  test("absolute paths are stored unchanged", async () => {
    const result = await runCli([
      "add",
      "default:path-task",
      '{"filepath":"/already/absolute"}',
    ]);
    expect(result.exitCode).toBe(0);
    expect(latestInput("default:path-task")).toEqual({
      filepath: "/already/absolute",
      verbose: false,
    });
  });

  test("path arrays are resolved element by element", async () => {
    const result = await runCli([
      "add",
      "default:files-task",
      '{"files":["a.txt","/abs/b.txt"]}',
    ]);
    expect(result.exitCode).toBe(0);
    expect(latestInput("default:files-task")).toEqual({
      files: [join(projectDir, "a.txt"), "/abs/b.txt"],
    });
  });

  test("schema violations print every issue and exit 2 without creating an instance", async () => {
    const before = instanceCount("default:path-task");
    const result = await runCli([
      "add",
      "default:path-task",
      '{"count":0,"mode":"turbo"}',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("/filepath");
    expect(result.stderr).toContain("/count");
    expect(result.stderr).toContain("/mode");
    expect(instanceCount("default:path-task")).toBe(before);
  });

  test("unknown task ids exit 2 with a clear error", async () => {
    const result = await runCli(["add", "nope:nope", "{}"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not found");
  });

  test("malformed JSON exits 2 with a clear error", async () => {
    const before = instanceCount("default:path-task");
    const result = await runCli(["add", "default:path-task", "{bad"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toLowerCase()).toContain("json");
    expect(instanceCount("default:path-task")).toBe(before);
  });

  test("@file reads JSON relative to the invocation directory", async () => {
    writeFileSync(
      join(projectDir, "context.json"),
      JSON.stringify({ filepath: "fixture/from-file" }),
    );
    const result = await runCli(["add", "default:path-task", "@context.json"]);
    expect(result.exitCode).toBe(0);
    expect(latestInput("default:path-task")).toEqual({
      filepath: join(projectDir, "fixture/from-file"),
      verbose: false,
    });
  });

  test("name=value assignments store strings", async () => {
    const result = await runCli(["add", "default:path-task", "filepath=fixture/x"]);
    expect(result.exitCode).toBe(0);
    expect(latestInput("default:path-task")).toEqual({
      filepath: join(projectDir, "fixture/x"),
      verbose: false,
    });
  });

  test("name:=value assignments parse JSON", async () => {
    const result = await runCli([
      "add",
      "default:path-task",
      "filepath=/abs/file",
      "count:=3",
      "verbose:=true",
    ]);
    expect(result.exitCode).toBe(0);
    expect(latestInput("default:path-task")).toEqual({
      filepath: "/abs/file",
      count: 3,
      verbose: true,
    });
  });

  test("bare string is wrapped for a single-required-string schema", async () => {
    const result = await runCli(["add", "default:bare-task", "fixture/1"]);
    expect(result.exitCode).toBe(0);
    expect(latestInput("default:bare-task")).toEqual({ filepath: "fixture/1" });
  });

  test("bare string with no schema is stored as a JSON string", async () => {
    const result = await runCli(["add", "default:noschema-task", "fixture/1"]);
    expect(result.exitCode).toBe(0);
    expect(latestInput("default:noschema-task")).toBe("fixture/1");
  });

  test("mixing assignments with JSON exits 2", async () => {
    const before = instanceCount("default:path-task");
    const result = await runCli([
      "add",
      "default:path-task",
      '{"filepath":"a"}',
      "count=2",
    ]);
    expect(result.exitCode).toBe(2);
    expect(instanceCount("default:path-task")).toBe(before);
  });
});
