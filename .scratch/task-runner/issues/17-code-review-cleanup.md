# 17: Code review, sample-task end-to-end verification, and cleanup

**What to build:** Run code review on the integration branch. Fix all issues raised. Verify the sample tasks (`ls`, `cat`, `env`, `sha256`, `minfo`) run through the runner contract end to end. Migrate the assertions from `tasks/test-cases/run-all.ts` into the real test suite where they belong; leave the fixtures in place. Ensure the existing sample-task behavior is preserved (redaction rules, sha256 digest of `hello`, env filtering, cat limit). Resolve all tickets. Clean up implementer subagent worktrees.

**Blocked by:** 16

**Status:** ready-for-agent

- [ ] Code review run on the integration branch via the `code-review` skill
- [ ] All issues raised by code review are fixed
- [ ] Sample tasks (`ls`, `cat`, `env`, `sha256`, `minfo`) run through the runner contract end to end
- [ ] `cat` redaction rules preserved (sensitive values → `[REDACTED]`)
- [ ] `env` redaction rules preserved (sensitive env var names/values → `[REDACTED]`)
- [ ] `sha256` digest of `hello` is `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`
- [ ] `cat` limit parameter works correctly
- [ ] `env` filter and values parameters work correctly
- [ ] Assertions from `tasks/test-cases/run-all.ts` migrated into the real test suite where they belong
- [ ] `tasks/test-cases/` fixtures left in place
- [ ] All tickets resolved
- [ ] Implementer subagent worktrees cleaned up
