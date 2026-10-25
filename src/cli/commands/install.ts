/**
 * `tq install <package>` command.
 *
 * Installs a task package with Bun, records it in the lockfile, and asks a live
 * daemon to reload through a durable control request. It never calls the daemon
 * HTTP API.
 */

import { addPackage, getLockfilePath, readLockfile } from "../../tasks/lockfile.ts";
import { bootstrapDataDir, resolveDataDir } from "../../db/database.ts";
import { openCliCore } from "../core.ts";

export async function commandInstall(
  dataDir: string,
  daemonRunning: boolean,
  projectRoot: string,
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
    cwd: projectRoot,
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
  const path = require("node:path");
  const nodeModules = path.resolve(projectRoot, "node_modules", packageName);
  const tasksDir = path.join(nodeModules, "tasks");
  const fs = require("node:fs");

  if (!fs.existsSync(tasksDir)) {
    console.error(`Package ${packageName} has no tasks/ directory`);
    return 2;
  }

  // Determine namespace from the package's package.json if present,
  // otherwise use the package name
  let namespace = packageName;
  const pkgJsonPath = path.join(nodeModules, "package.json");
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
  const existing = readLockfile(dataDir);

  // A package that claims the reserved `default` namespace cannot shadow
  // project/user tasks. Record it anyway; discovery reports the collision as a
  // load warning and skips the package's tasks.
  if (namespace === "default") {
    console.warn(
      `Warning: package ${packageName} declares reserved namespace "default"; its tasks will be skipped`,
    );
  }

  for (const p of existing.packages) {
    if (p.name === packageName) {
      console.log(`Package ${packageName} already installed, updating...`);
    }
  }

  // Get actual version from package.json if possible
  let version = "1.0.0";
  try {
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      if (typeof pkg.version === "string") {
        version = pkg.version;
      }
    }
  } catch {}

  addPackage(dataDir, packageName, version, tasksDir, namespace);
  console.log(`Installed ${packageName} (namespace: ${namespace})`);
  console.log(`Lockfile: ${lockfilePath}`);

  if (!daemonRunning) {
    console.log("No daemon running; tasks will be available when the daemon starts");
    return 0;
  }

  let cli;
  try {
    cli = openCliCore(dataDir, { projectRoot });
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const { loaded, warnings } = cli.core.reload();
    console.log(`Reloaded ${loaded} task(s)`);
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }
    if (!(await cli.core.requestReload())) {
      console.error("Error: daemon did not process the reload request in time");
      return 1;
    }
    return 0;
  } finally {
    cli.close();
  }
}
