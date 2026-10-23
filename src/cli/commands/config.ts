/**
 * `tq config` command.
 *
 * Default output shows the tq configuration (project, data dir, DB, logs,
 * daemon) and a basic line per registered task: name, path, description.
 *
 * `--tasks` instead dumps the full configuration of every registered task.
 */

import { openCliCore } from "../core.ts";
import { resolveDataDir } from "../../db/database.ts";
import type { TaskRow } from "../../db/schema.ts";
import { formatTable } from "../table.ts";

function formatDurationMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function printTqConfig(
  dataDir: string,
  daemonPort: number | null,
  projectRoot: string | undefined,
): void {
  const dbConfig = resolveDataDir(dataDir);
  if (projectRoot) console.log(`Project:   ${projectRoot}`);
  console.log(`Data dir:  ${dataDir}`);
  console.log(`DB path:   ${dbConfig.dbPath}`);
  console.log(`Logs:      ${dbConfig.logDir}`);
  console.log(
    `Daemon:    ${daemonPort != null ? `running on port ${daemonPort}` : "not running"}`,
  );
}

function printTaskList(tasks: TaskRow[]): void {
  console.log(
    formatTable([
      ["Task", "Name", "Path", "Description"],
      ...tasks.map((task) => [
        task.id,
        task.name || "—",
        task.entry_point ?? "—",
        task.description || "—",
      ]),
    ]),
  );
}

function printTaskConfigs(tasks: TaskRow[]): void {
  for (const [index, task] of tasks.entries()) {
    if (index > 0) console.log();
    console.log(`${task.id}`);
    console.log(`  name:         ${task.name || "—"}`);
    console.log(`  path:         ${task.entry_point ?? "—"}`);
    console.log(`  namespace:    ${task.namespace}`);
    console.log(`  description:  ${task.description || "—"}`);
    console.log(`  category:     ${task.category ?? "—"}`);
    console.log(`  concurrency:  ${task.concurrency}`);
    console.log(`  timeout:      ${formatDurationMs(task.timeout_ms)}`);

    if (task.input_schema != null) {
      console.log(`  input_schema:`);
      console.log(indent(task.input_schema.trimEnd()));
    } else {
      console.log(`  input_schema: —`);
    }

    const manifest = parseManifest(task);
    if (manifest != null) {
      console.log(`  settings:`);
      console.log(indent(JSON.stringify(manifest, null, 2)));
    }

    for (const warning of parseWarnings(task.manifest_warnings)) {
      console.log(`  warning:      ${warning}`);
    }
  }
}

function parseManifest(task: TaskRow): unknown {
  if (task.manifest_hash == null || task.manifest_hash === "") return null;
  try {
    return JSON.parse(task.manifest_hash) as unknown;
  } catch {
    return null;
  }
}

function parseWarnings(raw: string | null): string[] {
  if (raw == null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
    return [String(parsed)];
  } catch {
    return [raw];
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export async function commandConfig(
  dataDir: string,
  daemonPort: number | null,
  flags: Record<string, string | true>,
  projectRoot?: string,
): Promise<number> {
  printTqConfig(dataDir, daemonPort, projectRoot);
  console.log();

  let cli;
  try {
    cli = openCliCore(dataDir, { projectRoot });
  } catch (err: any) {
    if (err.message.includes("unable to open") || err.message.includes("no such file")) {
      console.log("No tasks registered. Run `tq daemon` or `tq reload` to discover tasks.");
      return 0;
    }
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const tasks = cli.core.listTaskDefinitions();

    if (tasks.length === 0) {
      console.log("No tasks registered.");
      return 0;
    }

    console.log(`Tasks: ${tasks.length} registered`);
    console.log();

    if (flags["tasks"] !== undefined) {
      printTaskConfigs(tasks);
    } else {
      printTaskList(tasks);
    }
  } finally {
    cli.close();
  }

  return 0;
}
