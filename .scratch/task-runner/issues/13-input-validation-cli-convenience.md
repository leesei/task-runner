# 13: Input validation, CLI conveniences, namespacing, and error messages

**What to build:** The input contract fully wired in core and used by both CLI and HTTP: the context is JSON validated against the task schema at enqueue time, with `INPUT_SCHEMA_VIOLATION` and field issues on failure. CLI context sources are escaped JSON, `@file`, `name=value` (string), and `name:=value` (JSON value), plus the existing bare-string conveniences. String properties marked `"format": "path"` are resolved by the CLI against the invocation directory before validation and stored absolute. Namespaced task ids, project-first precedence, and clear errors for unknown task ids, malformed JSON, and schema violations are covered. This ticket also covers the `install` command's namespace registration.

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] Context validated against JSON Schema subset at enqueue time: `type`, `properties`, `required`, `enum`, `minimum`, `maximum`, `default`, `description`, `format`
- [ ] Unknown JSON Schema keywords are ignored
- [ ] No schema → context accepted as-is (schema-less tasks)
- [ ] Validation runs in core so CLI and HTTP produce the same result
- [ ] Schema violation → `INPUT_SCHEMA_VIOLATION` with `{ path, message }` issues; no instance row created
- [ ] CLI schema violation → each issue printed, exit code 2
- [ ] HTTP schema violation → 400 `INPUT_SCHEMA_VIOLATION` with issues
- [ ] CLI context source: escaped/quoted JSON argument → that value
- [ ] CLI context source: `@file` reads JSON relative to the invocation directory
- [ ] CLI context source: `name=value` assigns a string; multiple pairs merge, later wins
- [ ] CLI context source: `name:=value` parses value as JSON (number, boolean, null, object, array)
- [ ] Mixing assignments with JSON/`@file` → usage error (exit code 2)
- [ ] Malformed JSON, unreadable `@file`, invalid `name:=value` → usage error (exit code 2)
- [ ] CLI convenience: bare string + single-required-string schema → wrapped as `{ "<property>": <argument> }`
- [ ] CLI convenience: bare string + no schema → passed as JSON string
- [ ] Any remaining case is a usage error (exit code 2)
- [ ] String properties with schema `"format": "path"` resolve relative values against the invocation directory; absolute values are unchanged
- [ ] Path arrays with `format: "path"` resolve every element
- [ ] Stored context is the normalized JSON value with absolute paths
- [ ] Unknown task id → clear error (exit code 2)
- [ ] Malformed JSON → clear error (exit code 2)
- [ ] Task ids are namespaced: `namespace:id` with `:` separator
- [ ] Project tasks win over user tasks with the same id (project-first precedence)
- [ ] Warning when two tasks claim the same id (shadowing is visible)
- [ ] Project and user task folders use `default` namespace by default
