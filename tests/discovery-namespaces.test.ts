import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  bootstrapDataDir,
  closeDatabase,
  openDatabase,
  resolveDataDir,
} from "../src/db/database.ts";
import { discoverAllTasks } from "../src/tasks/discovery.ts";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tq-discovery-test-"));
}

function writeTask(root: string, folder: string, settings: Record<string, unknown>) {
  const taskDir = join(root, folder);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "settings.json"), JSON.stringify(settings));
  writeFileSync(
    join(taskDir, "index.ts"),
    `export default async function(ctx) { ctx.done(0); }`,
  );
  writeFileSync(join(taskDir, "README.md"), `# ${folder}`);
}

describe("Seam A: discovery namespacing and precedence", () => {
  let dataDir: string;
  let db: ReturnType<typeof openDatabase>;
  const tempDirs: string[] = [];

  function temp() {
    const dir = makeTempDir();
    tempDirs.push(dir);
    return dir;
  }

  beforeAll(() => {
    dataDir = temp();
    bootstrapDataDir(resolveDataDir(dataDir));
    db = openDatabase(resolveDataDir(dataDir).dbPath);
  });

  afterAll(() => {
    closeDatabase(db);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shared module folders are not reported as malformed tasks", () => {
    const project = temp();
    writeTask(join(project, "tasks"), "real", { id: "real", name: "Real" });
    mkdirSync(join(project, "tasks", "lib"), { recursive: true });
    writeFileSync(join(project, "tasks", "lib", "helpers.ts"), "export {};\n");

    const { tasks, warnings } = discoverAllTasks(project, db, []);
    expect(tasks.map((t) => t.id)).toEqual(["default:real"]);
    expect(warnings).toEqual([]);
  });

  test("ids are namespace:id, defaulting to the default namespace", () => {
    const project = temp();
    writeTask(join(project, "tasks"), "plain", { id: "plain", name: "Plain" });
    writeTask(join(project, "tasks"), "tool", {
      namespace: "tools",
      id: "plain",
      name: "Tool plain",
    });

    const { tasks } = discoverAllTasks(project, db, []);
    expect(tasks.map((t) => t.id).sort()).toEqual(["default:plain", "tools:plain"]);
  });

  test("project tasks win over user tasks with the same id and warn", () => {
    const project = temp();
    const home = temp();
    writeTask(join(project, "tasks"), "shared", {
      id: "shared",
      name: "Project shared",
    });
    writeTask(join(home, ".task-runner", "tasks"), "shared", {
      id: "shared",
      name: "User shared",
    });

    const { tasks, warnings } = discoverAllTasks(
      project,
      db,
      [],
      join(home, ".task-runner", "tasks"),
    );
    expect(tasks.find((t) => t.id === "default:shared")!.manifest.name).toBe(
      "Project shared",
    );
    expect(warnings.join("\n")).toContain("default:shared");
    expect(warnings.join("\n")).toContain("project");
  });

  test("project tasks win over package tasks with the same id and warn", () => {
    const project = temp();
    const pkg = temp();
    writeTask(join(project, "tasks"), "shared", {
      namespace: "acme",
      id: "shared",
      name: "Project shared",
    });
    writeTask(join(pkg, "tasks"), "shared", { id: "shared", name: "Package shared" });

    const { tasks, warnings } = discoverAllTasks(project, db, [
      { name: "pkg", tasksDir: join(pkg, "tasks"), namespace: "acme" },
    ]);

    expect(tasks.find((t) => t.id === "acme:shared")!.manifest.name).toBe(
      "Project shared",
    );
    expect(warnings.join("\n")).toContain("acme:shared");
  });

  test("package tasks are registered under their declared namespace", () => {
    const project = temp();
    const pkg = temp();
    writeTask(join(pkg, "tasks"), "convert", { id: "convert", name: "Convert" });

    const { tasks } = discoverAllTasks(project, db, [
      { name: "pkg", tasksDir: join(pkg, "tasks"), namespace: "acme" },
    ]);

    expect(tasks.map((t) => t.id)).toEqual(["acme:convert"]);
  });

  test("a task manifest namespace wins over the package lockfile namespace", () => {
    const project = temp();
    const pkg = temp();
    writeTask(join(pkg, "tasks"), "convert", {
      namespace: "declared",
      id: "convert",
      name: "Convert",
    });

    const { tasks } = discoverAllTasks(project, db, [
      { name: "pkg", tasksDir: join(pkg, "tasks"), namespace: "acme" },
    ]);

    expect(tasks.map((t) => t.id)).toEqual(["declared:convert"]);
  });

  test("a package claiming the default namespace is rejected with a warning", () => {
    const project = temp();
    const pkg = temp();
    writeTask(join(pkg, "tasks"), "sneaky", { id: "sneaky", name: "Sneaky" });

    const { tasks, warnings } = discoverAllTasks(project, db, [
      { name: "pkg", tasksDir: join(pkg, "tasks"), namespace: "default" },
    ]);

    expect(tasks).toEqual([]);
    expect(warnings.join("\n")).toContain("default");
    expect(warnings.join("\n")).toContain("pkg");
  });

  test("two project tasks claiming the same id warn and only one is loaded", () => {
    const project = temp();
    writeTask(join(project, "tasks"), "a", { id: "dup", name: "First" });
    writeTask(join(project, "tasks"), "b", { id: "dup", name: "Second" });

    const { tasks, warnings } = discoverAllTasks(project, db, []);
    expect(tasks).toHaveLength(1);
    expect(["First", "Second"]).toContain(tasks[0]!.manifest.name);
    expect(warnings.join("\n")).toContain("default:dup");
  });
});
