# 17: Code review, sample-task end-to-end verification, and cleanup

**What to build:** Run code review on the integration branch. Fix all issues raised. Verify the sample tasks (`ls`, `cat`, `env`, `sha256`, `minfo`) run through the runner contract end to end. Migrate the assertions from `tasks/test-cases/run-all.ts` into the real test suite where they belong; leave the fixtures in place. Ensure the existing sample-task behavior is preserved (redaction rules, sha256 digest of `hello`, env filtering, cat limit). Resolve all tickets. Clean up implementer subagent worktrees.

**Blocked by:** 16

**Status:** done

- [x] Code review run on the integration branch via the `code-review` skill
- [x] All issues raised by code review are fixed
- [x] Sample tasks (`ls`, `cat`, `env`, `sha256`, `minfo`) run through the runner contract end to end
- [x] `cat` redaction rules preserved (sensitive values → `[REDACTED]`)
- [x] `env` redaction rules preserved (sensitive env var names/values → `[REDACTED]`)
- [x] `sha256` digest of `hello` is `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`
- [x] `cat` limit parameter works correctly
- [x] `env` filter and values parameters work correctly
- [x] Assertions from `tasks/test-cases/run-all.ts` migrated into the real test suite where they belong
- [x] `tasks/test-cases/` fixtures left in place
- [x] All tickets resolved
- [x] Implementer subagent worktrees cleaned up

## Comments

Code review ran on `main...HEAD` with parallel Standards and Spec axes. Fixes:

- Removed duplicate API handlers and committed conflict markers; `tsc --noEmit` is clean.
- `/api/tasks` returns each task's schema; `/api/queues` returns `total`; enqueue responses and `tq add` print the normalized context after schema defaults.
- `status` surfaces discovery warnings; reload deletes removed tasks and retires their queues.
- SSE event consumers are bounded and dropped rather than buffered without bound; the dashboard no longer fetches `/log` before subscribing to the replaying log stream.
- Abort grace expiry and throws after completion now warn; the abort control timeout has headroom over the runner's 5s grace.
- `install` runs `bun add` in the project root and treats the reserved `default` namespace as a discovery warning.
- Package task identity comes from the manifest; the lockfile namespace is only the fallback when `namespace` is omitted.

Sample-task assertions moved into `tests/sample-tasks.test.ts` and `tests/sample-tasks-runner.test.ts`; the ad-hoc `tests/run-all.ts` script was removed and its fixtures stayed in place. Manual e2e: `tq daemon` + `tq add default:cat` + `tq status` + `tq logs` produced the expected redacted log and a SUCCESS instance.

Verification: `bun test` → 145 pass, 0 fail; `bunx tsc --noEmit` → clean; `bun run build` → succeeds.
