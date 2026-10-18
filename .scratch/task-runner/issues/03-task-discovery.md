# 03: Task discovery from search path and manifest loading

**What to build:** Task discovery that walks the search path (project `tasks/` first, then user task folder under the user's `tq` home, then installed-package locations from a lockfile), reads each task folder's `settings.json` manifest, resolves the optional `inputSchema` file, and registers each valid task. Identity is declared in the manifest (`namespace` defaults to `default`, `id` is required). First match wins; conflicting later definitions are skipped and reported as warnings. A task with a malformed manifest, missing entrypoint, or unreadable schema is skipped with a warning rather than failing the whole load. Discovery results surface in `status` and `reload` output so authors can see warnings.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Search path order: project `tasks/` > user task folder > installed-package locations (lockfile order)
- [ ] Each task folder is read: `index.ts` entrypoint, `settings.json`, optional `inputSchema` file
- [ ] Task id is `namespace:id` from the manifest; `namespace` defaults to `default`; `id` is required
- [ ] First match wins — a task id already registered is skipped with a warning
- [ ] Malformed manifest, missing entrypoint, unreadable schema: skipped with warning, not fatal
- [ ] Warnings are collected and surfaced via `status` and `reload` output
- [ ] Entrypoint is imported by resolved file path so normal module resolution applies for shared modules
- [ ] User task folder location: under the user's home in a `tq` directory (e.g. `~/.tq/tasks/`)
- [ ] The lockfile (`.tq/packages.lock` or similar) lists installed packages and their task locations
