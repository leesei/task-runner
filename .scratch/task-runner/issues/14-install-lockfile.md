# 14: Install command, lockfile, and package task discovery

**What to build:** `tq install <package>` adds the package with Bun, locates its `tasks/` directory, and records the package and its namespace in a lockfile alongside the project. Discovery reads the lockfile; tasks execute from the installed location so package dependencies resolve normally. No extraction into the user directory in v1. Namespaces declared by installed packages must not collide with `default`; collisions are reported as load warnings. `install` works offline: it updates the package and lockfile. If a daemon is live, it calls core discovery and writes a reload control request instead of using HTTP; otherwise tasks are picked up when the daemon starts.

**Blocked by:** 13, 18

**Status:** done

- [x] `tq install <package>` adds the package with Bun
- [x] Installed package's `tasks/` directory is located and recorded
- [x] Package and namespace recorded in lockfile alongside the project
- [x] Discovery reads the lockfile for installed package task locations
- [x] Tasks execute from the installed location (normal module resolution for deps)
- [x] No extraction into user directory in v1
- [x] Installed package namespaces must not collide with `default`; collision → load warning
- [x] `install` works offline: updates package and lockfile
- [x] `install` calls core discovery and writes a reload request when a daemon is live
- [x] One package can ship several tasks in its `tasks/` directory
- [x] Tasks in a package can import shared modules from package root or `lib/`

**Evidence:**
- Implemented/verified in `src/cli/commands/install.ts` (adds package with Bun, locates `tasks/` in installed package, checks namespace collision with `default`, reads/writes lockfile via `addPackage`, calls `core.reload()` and `core.requestReload()` when daemon is live).
- Lockfile and discovery wiring present in `src/tasks/lockfile.ts` and `src/tasks/discovery.ts`; core loads package locations via `getPackageLocations(dataDir)` and passes to discovery.
- All tests pass (112 pass, 0 fail).

