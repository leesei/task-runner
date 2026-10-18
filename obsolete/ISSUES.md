# Open Issues — Task Runner

Issues to discuss/clarify further,logged as requested. Each has an owner-ish note on impact and a suggested next step.

## Input schema — inference vs. explicit

- **What's unsettled**: We chose explicit `schema.json` over inferring the input shape from the TS signature of `default`. Not yet decided whether a minimal task (no schema → input is a plain string) is a first-class convenience, or whether a schema is always required.
- **Impact**: `tq add` parsing logic; how the bare-string convenience wrapping works; whether `ls`/`minfo`/`sha256` (single-string input) need `schema.json` or can get by with a string schema.
- **Suggested next step**: Decide on a "string schema" shortcut (e.g. `settings.json` with `"inputType": "string"`) so simple tasks (ls, sha256, cat) don't need a full `schema.json`, then confirm `tq add` wrapping rules.

## ExecutionContext capture mechanism

- **What's unsettled**: How stdout/stderr are captured for the task. Options: (a) `WritableStream` the task writes to, (b) a `log(str, isErr)` callback the task calls, (c) the runner intercepts `console.log`/`console.error` globally for the task's execution scope.
- **Impact**: task entrypoint ergonomics; existing tasks that use `console.log` (e.g. `minfo.ts` does a lot of `console.log`) need to keep working without rewriting every log statement.
- **Suggested next step**: Pick (c) for ergonomics (runner temporarily redirects `console.log`/`console.error` per instance), or (b) if we want explicit log control. Avoid (a) unless tasks opt in — most tasks currently just print. Note: the `cat` and `env` tasks already do their own redaction on output, which is the task-side analogue of the dashboard-side concern — worth reconciling which layer owns redaction (task, runner, or dashboard).

## Same-process isolation guarantees

- **What's unsettled**: Same-process task execution with trusted tasks. Unclear what happens on unhandled error (runner catches → FAILED — probably fine), infinite loop (instance hangs → abort required), and memory leak (no isolation → affects daemon).
- **Impact**: robustness posture; whether `tq abort` needs a per-instance timeout; whether we document "trusted tasks" caveats now.
- **Suggested next step**: Add a per-instance timeout (configurable, default e.g. 30 min) as a safety net, and document the trusted-tasks caveat. Revisit process isolation later if needed.

## `tq` degradation behavior

- **What's unsettled**: How `tq` detects the daemon is running (PID file? lock file? try the API and fall back?), and whether `tq add` via direct DB needs to wake the daemon or polling is fine.
- **Impact**: CLI implementation; daemon wake-up semantics; whether `tq add` can "miss" a running daemon that doesn't poll fast enough.
- **Suggested next step**: Use a lock/PID file + API probe; daemon polls DB for PENDING on a short interval (e.g. 1s) so `tq add` without daemon is fine and `tq add` with daemon picks up quickly.

## Log retention and clear semantics

- **What's unsettled**: `clear` is destructive. Unclear whether to add auto-clear of old SUCCESS tasks, a non-destructive `tq archive`, or per-instance log rotation. Also whether `clear --all` can remove RUNNING (currently: no).
- **Impact**: `tq clear` behavior; log lifecycle; disk usage over time.
- **Suggested next step**: Keep `clear` destructive for now, refuse RUNNING on `--all`, and defer archive/retention to a later `tq archive` command.

## Dashboard — command exposure

- **What's unsettled**: Whether the dashboard gets in-page start/stop/abort buttons (calling the REST API from the browser) or stays observational with all ops on the CLI.
- **Impact**: dashboard UI scope; whether the REST API endpoints for start/stop/abort need auth/rate-limiting (they don't if only CLI uses them, but do if the dashboard calls them).
- **Suggested next step**: Start observational; add in-dashboard controls later if wanted. REST API for start/stop/abort is still useful as the CLI's backend and for future tooling.

## Task package install mechanics

- **What's unsettled**: Where installed package tasks land — `node_modules/<pkg>/tasks/` discovered via lockfile, or an extracted copy in `~/.taskrunner/tasks/<pkg>/`. Also how a task's own npm dependencies are resolved (does the daemon need the package installed, or are tasks bundled).
- **Impact**: install path; lockfile semantics; module resolution for tasks; whether `tq install` is just a bun add + symlink or a real extraction.
- **Suggested next step**: Start with `node_modules/<pkg>/tasks/` discovered via lockfile (no extraction; bun resolution handles deps). Add extraction to a user dir later if isolation/isolation-from-project is wanted.

## Namespace shadowing and search-path order

- **What's unsettled**: Search paths walked in order (project `tasks/`, user `~/.taskrunner/tasks/`, installed-package locations). Unclear if first match wins (shadowing) or if we merge/warn on conflicts, and whether a user task can shadow a project task with the same `namespace:id`.
- **Impact**: discovery semantics; conflict behavior; predictability for users.
- **Suggested next step**: First match wins (project can't shadow user by default? or project wins over user?). Decide order and shadowing rules, then warn on conflicts at `tq reload`.

## Daemon configuration

- **What's unsettled**: How config is expressed (config file `taskrunner.toml`/`taskrunner.json`/`.taskrunnerrc`, env vars, CLI flags, or a mix), and where it lives (project-level, user-level).
- **Impact**: startup behavior; portability; per-project vs. global daemon behavior.
- **Suggested next step**: Project-level config file (`taskrunner.toml`) for DB path, HTTP port, search paths, log dir, concurrency defaults; CLI flags override; env vars as a fallback. No user-level config for now.

## `tq reload` and live task discovery

- **What's unsettled**: Whether `tq reload` re-reads task manifests/schemas (so a changed `settings.json` takes effect without restart) or only picks up newly added/removed task folders.
- **Impact**: operational model for updating tasks; whether queue concurrency changes take effect on reload.
- **Suggested next step**: `tq reload` re-reads manifests/schemas for existing task folders AND picks up new/removed folders; concurrency changes take effect on reload (already-running instances are unaffected, new launches use the new limit).

## Task entrypoint file name (`index.ts` vs `default.ts`)

- **Status: resolved in sample**. The sample tasks were `tasks/ls.ts` and `tasks/minfo.ts` exporting `default (filepath: string) => Promise<number>`. They have been restructured into task folders (`tasks/ls/`, `tasks/minfo/`, `tasks/cat/`, `tasks/env/`, `tasks/sha256/`) with `index.ts` entrypoints exposing `runWith(ctx)` + `default`, plus `README.md`, `settings.json`, `schema.json`. The minfo task now imports shared helpers from `tasks/lib/media.ts`, demonstrating the package-level sharing model. New tasks added per request: `sha256`, `cat`, `env` — with `cat` and `env` redacting sensitive info from their output.
- **What's still open**: whether to keep the `runWith(ctx)` + `default` dual export or consolidate to a single `default(ctx)` export as the canonical entrypoint.
- **Impact**: first implemented tasks; whether the samples still work as before from the user's view.
- **Suggested next step**: Decide on the canonical entrypoint shape (single `default(ctx)` vs dual `runWith` + `default`), then align the sample tasks and the runner's task-loading code.
