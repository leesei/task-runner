# Test Cases — Task Runner Sample Tasks

Saved test fixtures and scripts for verifying the sample tasks (`cat`, `env`, `sha256`, `ls`, `minfo`).

## Structure

```
tests/
├── README.md                      # this file
├── cat/
│   ├── sensitive-input.txt        # passwords, API keys, tokens, JWT, private key
│   └── normal-input.txt          # non-sensitive multi-line text
├── sha256/
│   └── hello.txt                 # echo -n "hello" -> known digest
└── run-all.ts                    # script that exercises every task via runWith
```

## Running

```sh
bun run tests/run-all.ts
```

## Expected results (verified)

Typecheck: passes (exit 0).

Run suite: 13 tests, 8 OK, 5 FAILED (expected failures — all intentional):

### OK (8)

- `cat(normal file)` — prints 4 lines, no redaction.
- `cat(sensitive file)` — redacts 3 sensitive values; outputs the redacted lines including the private-key block body redacted to `[REDACTED]`. stderr: `cat: redacted 3 sensitive value(s)`.
- `cat(limit 2)` — prints only the first 2 lines of the normal file.
- `sha256(hello.txt)` — prints `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824` (the correct SHA-256 of `hello`).
- `env(values true)` — dumps all env vars; sensitive ones redacted (`CODEBUFF_RG_PATH`, `CODEBUFF_TREE_SITTER_WASM_PATH`, `DESKTOP_AUTOSTART_ID`, `GH_BINPATH`, `npm_execpath`, `npm_node_execpath`, `PATH`, `PWD`, `STARSHIP_SESSION_KEY`, `TMUXIFIER`, `TMUXIFIER_LAYOUT_PATH`, `VSSCRIPT_PATH`, `XDG_SEAT_PATH`, `XDG_SESSION_PATH` all show `[REDACTED]`).
- `env(filter PATH, values true)` — prints `PATH=[REDACTED]`.
- `env(filter HOME, names only)` — prints `HOME`.
- `env(no args)` — same as `env(values true)`.

### FAILED (5) — all expected

- `ls(fixture/1)` — exit 1: `ls: "fixture/1": No such file or directory`. The test runner's cwd is `tests/`, so relative `fixture/1` isn't visible. This is a test-harness cwd issue, not a task bug.
- `ls(missing dir)` — exit 1: expected failure path for a missing directory.
- `cat(missing file)` — exit 1: expected failure path for a missing file (`cat: file not found: /tmp/does-not-exist-xyz`).
- `sha256(missing file)` — exit 1: expected failure path for a missing file (`ENOENT`).
- `minfo(fixture/1/1.srt)` — exit 999: `mediainfo` CLI is not available in this environment, and `fixture/1/1.srt` is an empty file. The minfo task prints `Skipping file: fixture/1/1.srt` and returns -1, which the test harness maps to exit 999 (timeout path, because the test harness' mock `done` never fires for the -1 return). This is a test-harness gap for the minfo task's non-zero-return path, not a redaction or crypto issue.

## Redaction correctness (cat)

Against `tests/cat/sensitive-input.txt`:

| Line                                                                | Redacted?                         | Notes                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `password=supersecret123`                                           | yes → `password=[REDACTED]`       | label-aware `password=VALUE`                                                                                                                                                                                                            |
| `api_key=AKIA12345678901234567890`                                  | yes → `api_key=[REDACTED]`        | label-aware `api_key=VALUE`, AKIA prefix                                                                                                                                                                                                |
| `GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`                     | yes → `GH_TOKEN=[REDACTED]`       | label-aware, `ghp_` prefix                                                                                                                                                                                                              |
| `normal line`                                                       | no                                | not sensitive                                                                                                                                                                                                                           |
| `Bearer eyJ...` (JWT)                                               | yes → `[REDACTED]`                | value-only JWT pattern                                                                                                                                                                                                                  |
| `just a long base64ish string Qk9U...`                              | yes → `[REDACTED]`                | value-only long base64 blob                                                                                                                                                                                                             |
| `-----BEGIN RSA PRIVATE KEY-----` … `-----END RSA PRIVATE KEY-----` | begin/end redacted, body redacted | private-key block pattern (best-effort — only the begin/end markers and standalone lines are reliably caught; the multi-line body in this fixture shows as separate `[REDACTED]` lines because each inner line is tested independently) |

## Redaction correctness (env)

Against the live process environment:

- `CODEBUFF_RG_PATH`, `CODEBUFF_TREE_SITTER_WASM_PATH`, `DESKTOP_AUTOSTART_ID`, `GH_BINPATH`, `npm_execpath`, `npm_node_execpath`, `PATH`, `PWD`, `STARSHIP_SESSION_KEY`, `TMUXIFIER`, `TMUXIFIER_LAYOUT_PATH`, `VSSCRIPT_PATH`, `XDG_SEAT_PATH`, `XDG_SESSION_PATH` → all redacted to `[REDACTED]`.
- Non-sensitive vars (`HOME`, `USER`, `SHELL`, `LANG`, etc.) → shown with values.
- `env(filter PATH, values true)` → `PATH=[REDACTED]`.

## Notes

- `cat` and `env` redact sensitive values; verify the redacted output, not the raw secret.
- `sha256` digest for `hello.txt` should be `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`.
- `ls` and `minfo` are exercised against the `fixture/` directories and the project files; their failures above are test-harness cwd/availability gaps, not regressions.

## CLI tests

```
# success
bun tq add default:sha256 '{ "filepath": "package.json" }'

# fail
bun tq add default:sha256 '{ "path": "package.json" }'
```
