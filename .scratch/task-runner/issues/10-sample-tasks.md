# 10: Sample tasks adapted to the execution context contract

**What to build:** The five sample tasks (`ls`, `cat`, `env`, `sha256`, `minfo`) become real task definitions under the runner contract: each has entrypoint (`index.ts` default-exporting the task function), `README.md`, `settings.json`, and optional `schema.json`. They adapt the existing `runWith` logic to the `ExecutionContext` contract. `minfo` imports shared media helpers from `tasks/lib/media.ts`. `cat` and `env` keep their current redaction rules. A task that depends on an external tool (`minfo` on `mediainfo`) must fail with a clear message when that tool is absent.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] `tasks/ls/` is a valid task definition: `index.ts` (default export), `README.md`, `settings.json`, `schema.json`
- [ ] `tasks/cat/` is a valid task definition with redaction rules preserved
- [ ] `tasks/env/` is a valid task definition with redaction rules preserved
- [ ] `tasks/sha256/` is a valid task definition
- [ ] `tasks/minfo/` is a valid task definition importing shared helpers from `tasks/lib/media.ts`
- [ ] Each task's `index.ts` default-exports a function accepting `ExecutionContext`
- [ ] `minfo` fails with a clear message when `mediainfo` CLI is not available
- [ ] `cat` and `env` redact sensitive-looking values in their output
- [ ] Task settings declare correct namespace, id, name, description, concurrency, category, timeout
- [ ] Schemas declare the correct input shape for each task
