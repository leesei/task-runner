# 14: Install command, lockfile, and package task discovery

**What to build:** `tq install <package>` adds the package with Bun, locates its `tasks/` directory, and records the package and its namespace in a lockfile alongside the project. Discovery reads the lockfile; tasks execute from the installed location so package dependencies resolve normally. No extraction into the user directory in v1. Namespaces declared by installed packages must not collide with `default`; collisions are reported as load warnings. `install` works offline: it updates the package and lockfile, and triggers a reload if a daemon is reachable.

**Blocked by:** 13

**Status:** ready-for-agent

- [ ] `tq install <package>` adds the package with Bun
- [ ] Installed package's `tasks/` directory is located and recorded
- [ ] Package and namespace recorded in lockfile alongside the project
- [ ] Discovery reads the lockfile for installed package task locations
- [ ] Tasks execute from the installed location (normal module resolution for deps)
- [ ] No extraction into user directory in v1
- [ ] Installed package namespaces must not collide with `default`; collision → load warning
- [ ] `install` works offline: updates package and lockfile
- [ ] `install` triggers a reload if a daemon is reachable
- [ ] One package can ship several tasks in its `tasks/` directory
- [ ] Tasks in a package can import shared modules from package root or `lib/`
