# Test Cases — Task Runner Sample Tasks

Saved test fixtures and tests for verifying the sample tasks (`cat`, `env`, `sha256`, `ls`, `minfo`).

## Structure

```
tests/
├── README.md                      # this file
├── cat/
│   ├── sensitive-input.txt        # passwords, API keys, tokens, JWT, private key
│   └── normal-input.txt          # non-sensitive multi-line text
├── sha256/
│   └── hello.txt                 # echo -n "hello" -> known digest
├── sample-tasks.test.ts          # task contract, schemas, settings, and behavior
└── sample-tasks-runner.test.ts   # the five tasks executed through createRunner
```

## Running

```sh
bun test                          # includes the sample-task tests
```

## Expected results

The sample-task assertions live in `sample-tasks.test.ts` (direct task calls) and
`sample-tasks-runner.test.ts` (through the runner contract). Together they cover:

- `ls` — lists a fixture directory; missing directory exits 1.
- `cat` — prints normal files unchanged; redacts the sensitive fixture (8 values);
  missing file exits 1; `limit: 2` prints only the first 2 lines.
- `sha256` — prints `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`
  for `hello.txt`; missing file exits 1.
- `env` — dumps all env vars with sensitive ones redacted; `filter` and `values: false`
  work; no arguments behaves like `values: true`.
- `minfo` — reports a missing `mediainfo` CLI clearly; exits 0 for a readable media file
  when `mediainfo` is installed.

## Redaction correctness (cat)

Against `tests/cat/sensitive-input.txt`:

| Line                                                                | Redacted?                         | Notes                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `password=supersecret123`                                           | yes → `password=[REDACTED]`       | label-aware `password=VALUE`                                                                                 |
| `api_key=AKIA12345678901234567890`                                  | yes → `api_key=[REDACTED]`        | label-aware `api_key=VALUE`, AKIA prefix                                                                     |
| `GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`                     | yes → `GH_TOKEN=[REDACTED]`       | label-aware, `ghp_` prefix                                                                                   |
| `normal line`                                                       | no                                | not sensitive                                                                                                |
| `Bearer eyJ...` (JWT)                                               | yes → `Bearer [REDACTED]`         | `Bearer`/`Basic` scheme followed by a JWT-shaped value                                                       |
| `just a long base64ish string Qk9U...`                              | no                                | the embedded token is 35 characters; the base64 heuristic requires 40+                                       |
| `-----BEGIN RSA PRIVATE KEY-----` … `-----END RSA PRIVATE KEY-----` | begin/end and body redacted       | private-key markers and each long base64 body line are replaced with `[REDACTED]`                            |

## Redaction correctness (env)

Against the live process environment:

- Variables whose names look sensitive (for example `PATH`, `PWD`, `*_TOKEN`, `*_KEY`, `*_SECRET`) are shown as `[REDACTED]`.
- Non-sensitive vars (`HOME`, `USER`, `SHELL`, `LANG`, etc.) are shown with values.
- `env(filter PATH, values true)` → `PATH=[REDACTED]`.

## Notes

- `cat` and `env` redact sensitive values; verify the redacted output, not the raw secret.
- `sha256` digest for `hello.txt` should be `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`.
- `minfo` requires the `mediainfo` CLI. When it is absent, the task exits 1 with a clear `mediainfo CLI not found` message.

## CLI tests

```
# success
bun tq add default:sha256 '{ "filepath": "package.json" }'

# fail
bun tq add default:sha256 '{ "path": "package.json" }'
```
