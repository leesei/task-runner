/**
 * Task discovery from search path.
 *
 * Walks the search path in order:
 * 1. Project task folder (`tasks/` in the project root)
 * 2. User task folder (`~/.task-runner/tasks/`)
 * 3. Installed package locations (from the lockfile)
 *
 * First match wins. Shadows and load failures are reported as warnings rather
 * than silently skipped, so `status`/`reload` can explain why a task did not
 * register.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_DATA_DIR_NAME } from "../defaults.ts";
import type { DB } from "../db/database.ts";
import { getTask, insertTask } from "../db/queries.ts";

export interface TaskManifest {
  namespace?: string;
  id: string;
  name: string;
  description?: string;
  concurrency?: number;
  inputSchema?: string;
  category?: string;
  timeoutMs?: number;
  agents?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

export interface DiscoveredTask {
  id: string;
  manifest: TaskManifest;
  entryPoint: string; // absolute path to index.ts
  schemaPath: string | null; // absolute path to schema file, or null
  warnings: string[];
}

export interface DiscoveryResult {
  tasks: DiscoveredTask[];
  warnings: string[];
}

interface ResolvedTaskDir {
  task: DiscoveredTask | null;
  warnings: string[];
}

function parseManifest(path: string): TaskManifest | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as TaskManifest;
  } catch {
    return null;
  }
}

function readSchema(path: string): object | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as object;
  } catch {
    return null;
  }
}

function namespaceOf(id: string): string {
  const separator = id.indexOf(":");
  return separator >= 0 ? id.slice(0, separator) : "default";
}

function resolveTaskDir(
  taskDir: string,
  source: string,
  namespaceOverride?: string,
): ResolvedTaskDir {
  const folder = basename(taskDir);
  const settingsPath = join(taskDir, "settings.json");
  const indexPath = join(taskDir, "index.ts");
  const readmePath = join(taskDir, "README.md");
  const warnings: string[] = [];

  if (!existsSync(settingsPath)) {
    return {
      task: null,
      warnings: [`${source} task folder ${folder}: missing settings.json (skipped)`],
    };
  }

  const manifest = parseManifest(settingsPath);
  if (!manifest) {
    return {
      task: null,
      warnings: [
        `${source} task folder ${folder}: cannot parse settings.json (skipped)`,
      ],
    };
  }
  if (typeof manifest.id !== "string" || manifest.id.length === 0) {
    return {
      task: null,
      warnings: [
        `${source} task folder ${folder}: settings.json must declare an id (skipped)`,
      ],
    };
  }

  const namespace = namespaceOverride ?? manifest.namespace ?? "default";
  const id = `${namespace}:${manifest.id}`;

  if (!existsSync(indexPath)) {
    warnings.push(`Task ${id}: missing entrypoint index.ts (skipped)`);
  }
  if (!existsSync(readmePath)) {
    warnings.push(`Task ${id}: missing README.md (skipped)`);
  }

  // Resolve and parse the schema up front. A task with an unreadable or
  // malformed schema is skipped with a warning (D3), not silently treated as
  // schema-less.
  let schemaPath: string | null = null;
  if (manifest.inputSchema) {
    const candidate = join(taskDir, manifest.inputSchema);
    if (!existsSync(candidate)) {
      warnings.push(
        `Task ${id}: input schema not found: ${manifest.inputSchema} (skipped)`,
      );
    } else if (!readSchema(candidate)) {
      warnings.push(
        `Task ${id}: cannot read input schema ${manifest.inputSchema} (skipped)`,
      );
    } else {
      schemaPath = candidate;
    }
  }

  if (warnings.length > 0) {
    return { task: null, warnings };
  }

  return {
    task: {
      id,
      manifest,
      entryPoint: indexPath,
      schemaPath,
      warnings: [],
    },
    warnings: [],
  };
}

function looksLikeTaskDir(dir: string): boolean {
  return (
    existsSync(join(dir, "settings.json")) ||
    existsSync(join(dir, "index.ts")) ||
    existsSync(join(dir, "README.md")) ||
    existsSync(join(dir, "schema.json"))
  );
}

function scanTasksDir(
  tasksDir: string,
  source: string,
  warnings: string[],
  namespaceOverride?: string,
): DiscoveredTask[] {
  if (!existsSync(tasksDir)) return [];

  const entries = readdirSync(tasksDir, { withFileTypes: true });
  const tasks: DiscoveredTask[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskDir = join(tasksDir, entry.name);
    // Shared module directories (e.g. a package-level `lib/`) are not task
    // candidates; only warn when a folder actually looks like a task folder.
    if (!looksLikeTaskDir(taskDir)) continue;
    const resolved = resolveTaskDir(taskDir, source, namespaceOverride);
    warnings.push(...resolved.warnings);
    if (resolved.task) tasks.push(resolved.task);
  }

  return tasks;
}

export function discoverProjectTasks(
  projectRoot: string,
  warnings: string[] = [],
): DiscoveredTask[] {
  return scanTasksDir(join(projectRoot, "tasks"), "project", warnings);
}

export function discoverUserTasks(
  warnings: string[] = [],
  userTasksDir: string = join(homedir(), DEFAULT_DATA_DIR_NAME, "tasks"),
): DiscoveredTask[] {
  return scanTasksDir(userTasksDir, "user", warnings);
}

export interface PackageLocation {
  name: string;
  tasksDir: string;
  namespace: string;
}

export function discoverPackageTasks(
  locations: PackageLocation[],
  warnings: string[] = [],
): DiscoveredTask[] {
  const tasks: DiscoveredTask[] = [];

  for (const loc of locations) {
    // Installed packages must not claim the reserved project/user namespace.
    if (!loc.namespace || loc.namespace === "default") {
      warnings.push(
        `Task package ${loc.name} declares reserved namespace "default"; its tasks are skipped`,
      );
      continue;
    }

    if (!existsSync(loc.tasksDir)) {
      warnings.push(
        `Task package ${loc.name}: tasks directory not found: ${loc.tasksDir} (skipped)`,
      );
      continue;
    }

    tasks.push(
      ...scanTasksDir(
        loc.tasksDir,
        `package ${loc.name}`,
        warnings,
        loc.namespace,
      ),
    );
  }

  return tasks;
}

export function discoverAllTasks(
  projectRoot: string,
  _db: DB,
  packageLocations: PackageLocation[] = [],
  userTasksDir?: string,
): DiscoveryResult {
  const warnings: string[] = [];
  const seen = new Map<string, string>(); // id -> source
  const tasks: DiscoveredTask[] = [];

  function add(task: DiscoveredTask, source: string): void {
    const existing = seen.get(task.id);
    if (existing) {
      warnings.push(
        `Task ${task.id} from ${source} is shadowed by ${existing} (skipped)`,
      );
      return;
    }
    seen.set(task.id, source);
    tasks.push(task);
  }

  // 1. Project tasks (highest precedence)
  for (const task of discoverProjectTasks(projectRoot, warnings)) {
    add(task, "project");
  }

  // 2. User tasks
  for (const task of discoverUserTasks(warnings, userTasksDir)) {
    add(task, "user folder");
  }

  // 3. Package tasks (lowest precedence)
  for (const task of discoverPackageTasks(packageLocations, warnings)) {
    add(task, `package ${namespaceOf(task.id)}`);
  }

  return { tasks, warnings };
}

export function loadTaskIntoDatabase(db: DB, task: DiscoveredTask): boolean {
  const existing = getTask(db, task.id);
  if (existing) {
    const manifestJson = JSON.stringify(task.manifest);
    if (existing.manifest_hash !== manifestJson) {
      task.warnings.push(`Task ${task.id} manifest updated`);
    }
  }

  // The schema was parsed during discovery; re-read it here so the database
  // holds the exact text. Discovery has already rejected unreadable schemas.
  let inputSchema = null;
  if (task.schemaPath) {
    try {
      inputSchema = readFileSync(task.schemaPath, "utf-8");
    } catch {
      task.warnings.push(`Task ${task.id}: cannot read schema file`);
    }
  }

  insertTask(db, {
    id: task.id,
    namespace: namespaceOf(task.id),
    name: task.manifest.name ?? task.manifest.id,
    description: task.manifest.description ?? "",
    category: task.manifest.category ?? null,
    concurrency: task.manifest.concurrency ?? 1,
    timeout_ms: task.manifest.timeoutMs ?? 1800000,
    input_schema: inputSchema,
    manifest_hash: JSON.stringify(task.manifest),
    manifest_warnings:
      task.warnings.length > 0 ? JSON.stringify(task.warnings) : null,
    entry_point: task.entryPoint,
  });

  return true;
}

export function loadAllTasks(
  db: DB,
  projectRoot: string,
  packageLocations: PackageLocation[] = [],
): { loaded: number; warnings: string[] } {
  const result = discoverAllTasks(projectRoot, db, packageLocations);
  let loaded = 0;

  for (const task of result.tasks) {
    loadTaskIntoDatabase(db, task);
    loaded++;
  }

  const allWarnings = [...result.warnings];
  for (const task of result.tasks) {
    allWarnings.push(...task.warnings);
  }

  return { loaded, warnings: allWarnings };
}
