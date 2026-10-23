import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliDataDir } from "../src/cli/data-dir.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("CLI data directory resolution", () => {
  let root: string;
  const originalDataDir = process.env.TQ_DATA_DIR;

  beforeEach(() => {
    root = makeTempDir("tq-data-dir-");
    delete process.env.TQ_DATA_DIR;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.TQ_DATA_DIR;
    } else {
      process.env.TQ_DATA_DIR = originalDataDir;
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  /** A project is a directory with task definitions. */
  function makeProject(name: string): string {
    const project = join(root, name);
    mkdirSync(join(project, "tasks", "demo"), { recursive: true });
    writeFileSync(
      join(project, "tasks", "demo", "settings.json"),
      JSON.stringify({ id: "demo", name: "Demo" }),
    );
    return project;
  }

  function makeBinary(project: string): string {
    mkdirSync(join(project, "bin"), { recursive: true });
    const binary = join(project, "bin", "tq");
    writeFileSync(binary, "");
    return binary;
  }

  test("explicit --data-dir wins and resolves against the cwd", () => {
    const resolved = resolveCliDataDir(
      { "data-dir": "custom" },
      "/anywhere/bin/tq",
      root,
    );
    expect(resolved.dataDir).toBe(join(root, "custom"));
  });

  test("TQ_DATA_DIR wins over project discovery", () => {
    const project = makeProject("proj");
    process.env.TQ_DATA_DIR = join(root, "env-dir");

    const resolved = resolveCliDataDir({}, makeBinary(project), root);
    expect(resolved.dataDir).toBe(join(root, "env-dir"));
  });

  test("an explicit data dir still reports the discovered project root", () => {
    const project = makeProject("proj");
    const binary = makeBinary(project);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });

    const resolved = resolveCliDataDir(
      { "data-dir": join(root, "custom") },
      binary,
      elsewhere,
    );
    expect(resolved.dataDir).toBe(join(root, "custom"));
    expect(resolved.projectRoot).toBe(project);
  });

  test("finds the project from a subdirectory of it", () => {
    const project = makeProject("proj");
    const nested = join(project, "src", "cli");
    mkdirSync(nested, { recursive: true });

    const resolved = resolveCliDataDir({}, "/usr/local/bin/tq", nested);
    expect(resolved.dataDir).toBe(join(project, ".task-runner"));
    expect(resolved.projectRoot).toBe(project);
  });

  test("finds the project from the CLI script when the cwd is unrelated", () => {
    const project = makeProject("proj");
    const binary = makeBinary(project);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });

    const resolved = resolveCliDataDir({}, binary, elsewhere);
    expect(resolved.dataDir).toBe(join(project, ".task-runner"));
    expect(resolved.projectRoot).toBe(project);
  });

  test("does not detect a project from a leftover data directory", () => {
    const project = makeProject("proj");
    const binary = makeBinary(project);
    const parent = join(root, "parent");
    mkdirSync(join(parent, ".task-runner"), { recursive: true });
    writeFileSync(join(parent, ".task-runner", "taskrunner.db"), "");

    const resolved = resolveCliDataDir({}, binary, parent);
    expect(resolved.projectRoot).toBe(project);
    expect(resolved.dataDir).toBe(join(project, ".task-runner"));
  });

  test("a source directory named tasks/ is not mistaken for a project root", () => {
    const project = makeProject("proj");
    const sourceTasks = join(project, "src", "tasks");
    mkdirSync(sourceTasks, { recursive: true });
    writeFileSync(join(sourceTasks, "discovery.ts"), "export {};\n");

    const resolved = resolveCliDataDir({}, "/usr/local/bin/tq", join(project, "src"));
    expect(resolved.projectRoot).toBe(project);
  });

  test("discovers a project that has task definitions but no data directory", () => {
    const project = makeProject("proj");
    const resolved = resolveCliDataDir({}, "/usr/local/bin/tq", project);
    expect(resolved.dataDir).toBe(join(project, ".task-runner"));
    expect(resolved.projectRoot).toBe(project);
  });

  test("falls back to the default data directory under the cwd when no project is found", () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });

    const resolved = resolveCliDataDir(
      {},
      join(root, "missing", "bin", "tq"),
      plain,
    );
    expect(resolved.dataDir).toBe(join(plain, ".task-runner"));
    expect(resolved.projectRoot).toBe(plain);
  });
});
