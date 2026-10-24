# 10: Sample tasks adapted to the execution context contract

**What to build:** The five sample tasks (`ls`, `cat`, `env`, `sha256`, `minfo`) become real task definitions under the runner contract: each has entrypoint (`index.ts` default-exporting the task function), `README.md`, `settings.json`, and optional `schema.json`. They adapt the existing `runWith` logic to the `ExecutionContext` contract. `minfo` imports shared media helpers from `tasks/lib/media.ts`. `cat` and `env` keep their current redaction rules. A task that depends on an external tool (`minfo` on `mediainfo`) must fail with a clear message when that tool is absent.

**Blocked by:** 03

**Status:** done

- [x] `tasks/ls/` is a valid task definition: `index.ts` (default export), `README.md`, `settings.json`, `schema.json`
- [x] `tasks/cat/` is a valid task definition with redaction rules preserved
- [x] `tasks/env/` is a valid task definition with redaction rules preserved
- [x] `tasks/sha256/` is a valid task definition
- [x] `tasks/minfo/` is a valid task definition importing shared helpers from `tasks/lib/media.ts`
- [x] Each task's `index.ts` default-exports a function accepting `ExecutionContext`
- [x] `minfo` fails with a clear message when `mediainfo` CLI is not available
- [x] `cat` and `env` redact sensitive-looking values in their output
- [x] Task settings declare correct namespace, id, name, description, concurrency, category, timeout
- [x] Schemas declare the correct input shape for each task
- [x] File-operating tasks mark path string properties with `"format": "path"` so the CLI resolves relative paths

## Comments

- Implemented on `ticket-10-sample-tasks` in commit `4196ef5`.
- Fixed `cat` labeled redaction (the `g` regex was passed to `String.match()`), added `Bearer`/`Basic` and private-key footer handling.
- Fixed `ls` passing literal quotes to the system command.
- `minfo` now exits 1 with `mediainfo CLI not found; install mediainfo ...` when the binary is absent, and reports malformed/no-track output instead of returning `-1`.
- Added `timeoutMs: 1800000` to all five settings and `"format": "path"` to file path properties in `ls`, `cat`, `sha256`, and `minfo` schemas.
- Evidence: `bun test` -> 44 pass / 0 fail; `bun run tests/run-all.ts` -> 13 tests, 0 failed; `bun run build` succeeds.
- Added `tests/sample-tasks.test.ts` (task contract/behavior) and `tests/sample-tasks-runner.test.ts` (all five tasks through `createRunner`).
