# 13: Input validation, CLI conveniences, namespacing, and error messages

**What to build:** The input contract fully wired in core and used by both CLI and HTTP: the context is JSON validated against the task schema at enqueue time, with `INPUT_SCHEMA_VIOLATION` and field issues on failure. CLI context sources are escaped JSON, `@file`, `name=value` (string), and `name:=value` (JSON value), plus the existing bare-string conveniences. String properties marked `"format": "path"` are resolved by the CLI against the invocation directory before validation and stored absolute. Namespaced task ids, project-first precedence, and clear errors for unknown task ids, malformed JSON, and schema violations are covered. This ticket also covers the `install` command's namespace registration.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Context validated against JSON Schema subset at enqueue time: `type`, `properties`, `required`, `enum`, `minimum`, `maximum`, `default`, `description`, `format`
- [x] Unknown JSON Schema keywords are ignored
- [x] No schema → context accepted as-is (schema-less tasks)
- [x] Validation runs in core so CLI and HTTP produce the same result
- [x] Schema violation → `INPUT_SCHEMA_VIOLATION` with `{ path, message }` issues; no instance row created
- [x] CLI schema violation → each issue printed, exit code 2
- [x] HTTP schema violation → 400 `INPUT_SCHEMA_VIOLATION` with issues
- [x] CLI context source: escaped/quoted JSON argument → that value
- [x] CLI context source: `@file` reads JSON relative to the invocation directory
- [x] CLI context source: `name=value` assigns a string; multiple pairs merge, later wins
- [x] CLI context source: `name:=value` parses value as JSON (number, boolean, null, object, array)
- [x] Mixing assignments with JSON/`@file` → usage error (exit code 2)
- [x] Malformed JSON, unreadable `@file`, invalid `name:=value` → usage error (exit code 2)
- [x] CLI convenience: bare string + single-required-string schema → wrapped as `{ "<property>": <argument> }`
- [x] CLI convenience: bare string + no schema → passed as JSON string
- [x] Any remaining case is a usage error (exit code 2)
- [x] String properties with schema `"format": "path"` resolve relative values against the invocation directory; absolute values are unchanged
- [x] Path arrays with `format: "path"` resolve every element
- [x] Stored context is the normalized JSON value with absolute paths
- [x] Unknown task id → clear error (exit code 2)
- [x] Malformed JSON → clear error (exit code 2)
- [x] Task ids are namespaced: `namespace:id` with `:` separator
- [x] Project tasks win over user tasks with the same id (project-first precedence)
- [x] Warning when two tasks claim the same id (shadowing is visible)
- [x] Project and user task folders use `default` namespace by default

## Comments

Implemented on `ticket-13-validation` in `914794c`.

- `src/core/validation.ts` uses `ajv` 8 (`strict: false`, defaults applied, unknown keywords ignored). `enqueueTask` validates before any queue/instance write and throws `INPUT_SCHEMA_VIOLATION` with `{ path, message }` issues.
- `src/cli/context.ts` parses JSON, `@file`, `name=value`, `name:=value`, and bare strings, then resolves `format: "path"` strings and arrays against the invocation directory.
- `tq add` prints every issue and exits 2; `POST /api/instances` returns 400 with the same code and issues.
- Discovery now reports shadowing and load failures, and rejects package tasks claiming the reserved `default` namespace.
- Dependency: `ajv@^8.20.0` added to `package.json` and `bun.lock`.

Evidence: after merging `feat/task-runner-spec`, `bun test` → 88 pass / 0 fail (12 files); `bun run build` succeeds. CLI probe: `{"count":0}` printed `/filepath` and `/count`, exited 2, created no row; `{"filepath":"fixture/1"}` stored the absolute path and exited 0. Sample-task probe: `tq add default:ls tests/1` and `tq add default:cat '{"filepath":"tests/sha256/hello.txt","limit":3}'` both stored absolute paths and exited 0; discovery reported no spurious warnings for `tasks/lib`.

