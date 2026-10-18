/**
 * `tq install <package>` command.
 *
 * Installs a task package with Bun, records it in the lockfile, and
 * triggers a reload if a daemon is reachable.
 * Works offline: updates the package and lockfile; reload requires daemon.
 */

import { addPackage, getLockfilePath } from "../../tasks/lockfile.ts";
import { resolveDataDir, bootstrapDataDir } from "../../db/database.ts";
import { loadAllTasks } from "../../tasks/discovery.ts";
import { getPackageLocations } from "../../tasks/lockfile.ts";
import { ensureQueuesForTasks } from "../../runner/queue-state.ts";
import { openDatabase, closeDatabase } from "../../db/database.ts";

export async function commandInstall(
  dataDir: string,
  daemonPort: number | null,
  args: string[],
  _flags: Record<string, string | true>,
): Promise<number> {
  if (args.length === 0) {
    console.error("Usage: tq install <package>");
    return 2;
  }

  const packageName = args[0]!;

  // Install the package with Bun
  console.log(`Installing ${packageName}...`);
  const proc = Bun.spawn(["bun", "add", packageName], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`Failed to install ${packageName}`);
    return 1;
  }

  // Locate the installed package's tasks directory
  // Bun installs to node_modules; look for a tasks/ subdirectory
  const nodeModules = `node_modules/${packageName}`;
  const tasksDir = `${nodeModules}/tasks`;
  const fs = require("node:fs");

  if (!fs.existsSync(tasksDir)) {
    console.error(`Package ${packageName} has no tasks/ directory`);
    return 2;
  }

  // Determine namespace from the package's package.json if present,
  // otherwise use the package name
  let namespace = packageName;
  const pkgJsonPath = `${nodeModules}/package.json`;
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      if (pkg.namespace) namespace = pkg.namespace;
    } catch {}
  }

  // Bootstrap data dir if needed and record in lockfile
  const dbConfig = resolveDataDir(dataDir);
  try {
    bootstrapDataDir(dbConfig);
  } catch (err: any) {
    console.error(`Error creating data directory: ${err.message}`);
    return 1;
  }

  const lockfilePath = getLockfilePath(dataDir);
  // Read existing lockfile to check for conflicts
  const existingLockfilePath = lockfilePath;
  const { readLockfile } = await import("../../tasks/lockfile.ts");
  const existing = readLockfile(dataDir);

  // Check namespace collision with default
  if (namespace === "default") {
    console.error("Error: installed packages must not use the 'default' namespace");
    return 2;
  }

  for (const p of existing.packages) {
    if (p.name === packageName) {
      console.log(`Package ${packageName} already installed, updating...`);
    }
  }

  addPackage(dataDir, packageName, "1.0.0", tasksDir, namespace);
  console.log(`Installed ${packageName} (namespace: ${namespace})`);

  // If daemon is reachable, reload to pick up new tasks
  if (daemonPort !== null) {
    try {
      const res = await fetch(
        `http://localhost:${daemonPort}/api/reload`,
        { method: "POST" },
      );
      if (res.ok) {
        const body = (await res.json()) as { reloaded: number; warnings: string[] };
        console.log(`Reloaded ${body.reloaded} task(s)`);
        if (body.warnings.length > 0) {
          for (const w of body.warnings) {
            console.warn(`Warning: ${w}`);
          }
        }
      } else {
        console.warn("Daemon reload failed; tasks will be picked up on next start");
      }
    } catch {
      console.warn("Daemon not reachable; tasks will be picked up on next start");
    }
  } else {
    console.log("No daemon running; tasks will be available when the daemon starts");
  }

  return 0;
}

