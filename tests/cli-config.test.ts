import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commandConfig } from "../src/cli/commands/config.ts";
import { openDatabase, closeDatabase, resolveDataDir } from "../src/db/database.ts";
import { insertTask } from "../src/db/queries.ts";

const tempDirs: string[] = [];

function makeTaskDb(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "tq-config-test-"));
  tempDirs.push(dataDir);
  const db = openDatabase(resolveDataDir(dataDir).dbPath);
  insertTask(db, {
    id: "default:demo",
    namespace: "default",
    name: "Demo task",
    description: "Does a demo thing",
    category: "test",
    concurrency: 3,
    timeout_ms: 5000,
    input_schema: '{"type":"object","required":["path"]}',
    manifest_hash: JSON.stringify({
      namespace: "default",
      id: "demo",
      name: "Demo task",
      description: "Does a demo thing",
      concurrency: 3,
      category: "test",
      agents: { cli: { argumentHint: "<path>" } },
    }),
    manifest_warnings: JSON.stringify(["demo warning"]),
    entry_point: "/project/tasks/demo/index.ts",
  });
  closeDatabase(db);
  return dataDir;
}

async function captureConfig(
  dataDir: string,
  flags: Record<string, string | true>,
): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const code = await commandConfig(
      dataDir,
      null,
      flags,
      "/project",
    );
    expect(code).toBe(0);
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tq config", () => {
  test("shows tq config and basic task info only", async () => {
    const output = await captureConfig(makeTaskDb(), {});

    expect(output).toContain("Project:   /project");
    expect(output).toContain("Data dir:");
    expect(output).toContain("DB path:");
    expect(output).toContain("Logs:");
    expect(output).toContain("Daemon:    not running");
    expect(output).toContain("Tasks: 1 registered");
    expect(output).toContain("default:demo");
    expect(output).toContain("Demo task");
    expect(output).toContain("/project/tasks/demo/index.ts");
    expect(output).toContain("Does a demo thing");
    expect(output).not.toContain("concurrency");
    expect(output).not.toContain("settings:");
  });

  test("--tasks dumps the full config of every task", async () => {
    const output = await captureConfig(makeTaskDb(), { tasks: true });

    expect(output).toContain("default:demo");
    expect(output).toContain("concurrency:  3");
    expect(output).toContain("timeout:      5.0s");
    expect(output).toContain("input_schema:");
    expect(output).toContain('"required"');
    expect(output).toContain("settings:");
    expect(output).toContain('"agents"');
    expect(output).toContain("warning:      demo warning");
  });
});
