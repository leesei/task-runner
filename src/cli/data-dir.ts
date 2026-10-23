/**
 * Project and data-directory resolution for the CLI.
 *
 * The CLI may be invoked from anywhere — a subdirectory of the project, or as
 * `/path/to/project/bin/tq` from an unrelated working directory — so it must
 * locate the project rather than assume the cwd is the project root.
 *
 * A directory is a project when it contains task definitions: a `tasks/`
 * folder with at least one `<task>/settings.json`. The data directory itself
 * is never used as a marker; its name is only the default value below.
 *
 * Resolution order:
 * 1. `--data-dir` flag
 * 2. `TQ_DATA_DIR` environment variable
 * 3. the closest ancestor of the cwd that is a project
 * 4. the closest ancestor of the CLI script that is a project
 * 5. the default data directory under the cwd (fresh/empty directory)
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_DATA_DIR_NAME } from "../defaults.ts";

export interface ResolvedCliDataDir {
  dataDir: string;
  projectRoot: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A `tasks/` directory only marks a project root if it actually holds task
 * definitions (a folder with `settings.json`). A plain source directory named
 * `tasks/` — as in `src/tasks/` — must not be mistaken for a project root.
 */
function hasTaskDefinitions(dir: string): boolean {
  const tasksDir = join(dir, "tasks");
  if (!isDirectory(tasksDir)) return false;
  try {
    return readdirSync(tasksDir, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() && existsSync(join(tasksDir, entry.name, "settings.json")),
    );
  } catch {
    return false;
  }
}

/**
 * A project root is a directory that contains task definitions. Directories
 * are never recognized by the presence of a data directory, so a configured
 * or leftover data directory cannot capture unrelated commands.
 */
function looksLikeProject(dir: string): boolean {
  return hasTaskDefinitions(dir);
}

export function findProjectRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (looksLikeProject(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function scriptDirectory(argvPath: string | undefined, cwd: string): string | null {
  if (!argvPath) return null;
  const absolute = resolve(cwd, argvPath);
  try {
    // Resolve symlinks so a `tq` linked into PATH still finds its project.
    return dirname(realpathSync(absolute));
  } catch {
    // The path may not exist (e.g. an in-process caller); use its parent when
    // that directory is real.
    const dir = dirname(absolute);
    return isDirectory(dir) ? dir : null;
  }
}

export function resolveCliDataDir(
  flags: Record<string, string | true>,
  argvPath: string | undefined = process.argv[1],
  cwd: string = process.cwd(),
): ResolvedCliDataDir {
  cwd = resolve(cwd);

  const byCwd = findProjectRoot(cwd);
  const scriptDir = scriptDirectory(argvPath, cwd);
  const byScript = scriptDir ? findProjectRoot(scriptDir) : null;
  const projectRoot = byCwd ?? byScript ?? cwd;

  // An explicit data directory is the caller's choice; only its relative
  // basis (the cwd) is defined here.
  const flag = flags["data-dir"];
  if (flag !== undefined && flag !== true) {
    return { dataDir: resolve(cwd, String(flag)), projectRoot };
  }

  const env = process.env.TQ_DATA_DIR;
  if (env !== undefined && env !== "") {
    return { dataDir: resolve(cwd, env), projectRoot };
  }

  return { dataDir: join(projectRoot, DEFAULT_DATA_DIR_NAME), projectRoot };
}
