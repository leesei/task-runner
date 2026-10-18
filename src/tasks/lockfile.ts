/**
 * Package lockfile for installed task packages.
 *
 * Records installed packages and their task locations.
 * Format: JSON array of { name, version, tasksDir, namespace }
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface LockedPackage {
  name: string;
  version: string;
  tasksDir: string;
  namespace: string;
}

export interface Lockfile {
  packages: LockedPackage[];
  version: number;
}

const LOCKFILE_VERSION = 1;

export function getLockfilePath(dataDir: string): string {
  return join(dataDir, "packages.lock");
}

export function readLockfile(dataDir: string): Lockfile {
  const path = getLockfilePath(dataDir);
  if (!existsSync(path)) {
    return { packages: [], version: LOCKFILE_VERSION };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Lockfile;
  } catch {
    return { packages: [], version: LOCKFILE_VERSION };
  }
}

export function writeLockfile(dataDir: string, lockfile: Lockfile): void {
  const path = getLockfilePath(dataDir);
  writeFileSync(path, JSON.stringify(lockfile, null, 2));
}

export function addPackage(
  dataDir: string,
  name: string,
  version: string,
  tasksDir: string,
  namespace: string,
): Lockfile {
  const lockfile = readLockfile(dataDir);

  // Check if package already exists
  const existingIdx = lockfile.packages.findIndex(
    p => p.name === name,
  );

  const packageEntry: LockedPackage = {
    name,
    version,
    tasksDir,
    namespace,
  };

  if (existingIdx >= 0) {
    lockfile.packages[existingIdx] = packageEntry;
  } else {
    lockfile.packages.push(packageEntry);
  }

  writeLockfile(dataDir, lockfile);
  return lockfile;
}

export function removePackage(dataDir: string, name: string): Lockfile {
  const lockfile = readLockfile(dataDir);
  lockfile.packages = lockfile.packages.filter(p => p.name !== name);
  writeLockfile(dataDir, lockfile);
  return lockfile;
}

export function getPackageLocations(dataDir: string): { name: string; tasksDir: string; namespace: string }[] {
  const lockfile = readLockfile(dataDir);
  return lockfile.packages.map(p => ({
    name: p.name,
    tasksDir: p.tasksDir,
    namespace: p.namespace,
  }));
}
