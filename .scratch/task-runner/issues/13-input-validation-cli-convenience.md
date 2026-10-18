# 13: Input validation, CLI conveniences, namespacing, and error messages

**What to build:** The input contract fully wired: schema validation at enqueue time, CLI convenience wrapping (bare string → wrapped for single-required-string schema; bare string → JSON string for schema-less; JSON argument → that value), namespaced task ids (`namespace:id`), project-first precedence, and clear error messages for unknown task ids, malformed JSON, and schema violations. This ticket also covers the `install` command's namespace registration.

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] Input validated against JSON Schema subset at enqueue time: `type`, `properties`, `required`, `enum`, `minimum`, `maximum`, `default`, `description`
- [ ] Unknown JSON Schema keywords are ignored
- [ ] No schema → input accepted as-is (schema-less tasks)
- [ ] CLI convenience: JSON argument → that value as input
- [ ] CLI convenience: bare string + single-required-string schema → wrapped as `{ "<property>": <argument> }`
- [ ] CLI convenience: bare string + no schema → passed as JSON string
- [ ] Any remaining case is a usage error (exit code 2)
- [ ] Stored input is always the normalized JSON value
- [ ] Invalid input rejected at enqueue time with clear message (exit code 2)
- [ ] Unknown task id → clear error (exit code 2)
- [ ] Malformed JSON → clear error (exit code 2)
- [ ] Schema violation → clear error describing the violation (exit code 2)
- [ ] Task ids are namespaced: `namespace:id` with `:` separator
- [ ] Project tasks win over user tasks with the same id (project-first precedence)
- [ ] Warning when two tasks claim the same id (shadowing is visible)
- [ ] Project and user task folders use `default` namespace by default
