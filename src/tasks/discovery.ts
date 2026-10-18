/**
 * Task discovery from search path.
 *
 * Walks the search path in order:
 * 1. Project task folder (tasks/ in cwd)
 * 2. User task folder (~/.tq/tasks/)
 * 3. Installed package locations (from lockfile)
 *
 * First match wins. Conflicts are reported as warnings.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { DB } from "../db/database.ts";
import { insertTask, ensureQueue, getTask } from "../db/queries.ts";
import type { TaskRow } from "../db/schema.ts";

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
  entryPoint: string;  // absolute path to index.ts
  schemaPath: string | null;  // absolute path to schema file, or null
  warnings: string[];
}

export interface DiscoveryResult {
  tasks: DiscoveredTask[];
  warnings: string[];
}

function parseManifest(path: string): TaskManifest | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as TaskManifest;
  } catch (err: any) {
    return null;
  }
}

function resolveTaskDir(taskDir: string): DiscoveredTask | null {
  const settingsPath = join(taskDir, "settings.json");
  const indexPath = join(taskDir, "index.ts");
  const readmePath = join(taskDir, "README.md");

  // Check required files exist
  if (!existsSync(settingsPath)) return null;
  if (!existsSync(indexPath)) return null;
  if (!existsSync(readmePath)) return null;

  const manifest = parseManifest(settingsPath);
  if (!manifest || !manifest.id) return null;

  const namespace = manifest.namespace ?? "default";
  const id = `${namespace}:${manifest.id}`;

  // Resolve schema path if specified
  let schemaPath: string | null = null;
  if (manifest.inputSchema) {
    const schemaCandidate = join(taskDir, manifest.inputSchema);
    if (existsSync(schemaCandidate)) {
      schemaPath = schemaCandidate;
    }
  }

  return {
    id,
    manifest,
    entryPoint: join(taskDir, "index.ts"),
    schemaPath,
    warnings: [],
  };
}

export function discoverProjectTasks(projectRoot: string): DiscoveredTask[] {
  const tasksDir = join(projectRoot, "tasks");
  if (!existsSync(tasksDir)) return [];

  const entries = readdirSync(tasksDir, { withFileTypes: true });
  const tasks: DiscoveredTask[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskDir = join(tasksDir, entry.name);
    const discovered = resolveTaskDir(taskDir);
    if (discovered) {
      tasks.push(discovered);
    }
  }

  return tasks;
}

export function discoverUserTasks(): DiscoveredTask[] {
  const userTasksDir = join(homedir(), ".tq", "tasks");
  if (!existsSync(userTasksDir)) return [];

  const entries = readdirSync(userTasksDir, { withFileTypes: true });
  const tasks: DiscoveredTask[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskDir = join(userTasksDir, entry.name);
    const discovered = resolveTaskDir(taskDir);
    if (discovered) {
      tasks.push(discovered);
    }
  }

  return tasks;
}

export interface PackageLocation {
  name: string;
  tasksDir: string;
  namespace: string;
}

export function discoverPackageTasks(locations: PackageLocation[]): DiscoveredTask[] {
  const tasks: DiscoveredTask[] = [];

  for (const loc of locations) {
    if (!existsSync(loc.tasksDir)) continue;

    const entries = readdirSync(loc.tasksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskDir = join(loc.tasksDir, entry.name);
      const discovered = resolveTaskDir(taskDir);
      if (discovered) {
        // Override namespace from package
        discovered.id = `${loc.namespace}:${discovered.manifest.id}`;
        tasks.push(discovered);
      }
    }
  }

  return tasks;
}

export function discoverAllTasks(
  projectRoot: string,
  db: DB,
  packageLocations: PackageLocation[] = [],
): DiscoveryResult {
  const warnings: string[] = [];
  const seen = new Map<string, string>(); // id -> source
  const tasks: DiscoveredTask[] = [];

  // 1. Project tasks (highest precedence)
  const projectTasks = discoverProjectTasks(projectRoot);
  for (const task of projectTasks) {
    const existing = seen.get(task.id);
    if (existing) {
      warnings.push(
        `Task ${task.id} from project shadows ${existing} (skipped)`,
      );
      continue;
    }
    seen.set(task.id, "project");
    tasks.push(task);
  }

  // 2. User tasks
  const userTasks = discoverUserTasks();
  for (const task of userTasks) {
    const existing = seen.get(task.id);
    if (existing && existing !== "project") {
      warnings.push(
        `Task ${task.id} from user folder shadows ${existing} (skipped)`,
      );
      continue;
    }
    if (existing === "project") {
      // Project wins over user — skip user task silently
      continue;
    }
    seen.set(task.id, "user");
    tasks.push(task);
  }

  // 3. Package tasks (lowest precedence)
  const packageTasks = discoverPackageTasks(packageLocations);
  for (const task of packageTasks) {
    const existing = seen.get(task.id);
    if (existing) {
      warnings.push(
        `Task ${task.id} from package ${task.manifest.name || "unknown"} shadows ${existing} (skipped)`,
      );
      continue;
    }
    seen.set(task.id, "package");
    tasks.push(task);
  }

  return { tasks, warnings };
}

export function loadTaskIntoDatabase(db: DB, task: DiscoveredTask): boolean {
  // Check if task already exists
  const existing = getTask(db, task.id);
  if (existing) {
    // Update if manifest changed
    const manifestJson = JSON.stringify(task.manifest);
    if (existing.manifest_hash !== manifestJson) {
      task.warnings.push(`Task ${task.id} manifest updated`);
    }
  }

  // Read schema if present
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
    namespace: task.manifest.namespace ?? "default",
    name: task.manifest.name ?? task.manifest.id,
    description: task.manifest.description ?? "",
    category: task.manifest.category ?? null,
    concurrency: task.manifest.concurrency ?? 1,
    timeout_ms: task.manifest.timeoutMs ?? 1800000,
    input_schema: inputSchema,
    manifest_hash: JSON.stringify(task.manifest),
    manifest_warnings: task.warnings.length > 0 ? JSON.stringify(task.warnings) : null,
    entry_point: task.entryPoint,
  });

  // Ensure queue exists
  ensureQueue(db, task.id, task.manifest.concurrency ?? 1);

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

  // Collect all warnings
  const allWarnings = [...result.warnings];
  for (const task of result.tasks) {
    if (task.warnings.length > 0) {
      const existing = allWarnings.find(w => w.includes(task.id));
      if (!existing) {
        allWarnings.push(...task.warnings);
      }
    }
  }

  // Also collect warnings from tasks that failed to load
  const failedTasks = discoverAllTasks(projectRoot, db, packageLocations);
  // (Re-discovery to find tasks that were skipped due to conflicts)

  return { loaded, warnings: allWarnings };
}
