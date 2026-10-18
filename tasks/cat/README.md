# cat

Prints a file's contents to stdout, with sensitive values redacted.

Redaction is a best-effort scan: values that look like secrets (API keys, tokens, passwords, private keys, AWS credentials, JWTs) are replaced with `[REDACTED]` in the output. This is intended to make log inspection on the dashboard safer, not to guarantee no secret ever leaks.

## Usage

```sh
tq add default:cat <filepath>
tq add default:cat '{"filepath":"fixture/1/1.srt"}'
tq add default:cat '{"filepath":"fixture/1/1.srt","limit":20}'
```

## Input

| Field    | Type    | Required | Description                              |
|----------|---------|----------|------------------------------------------|
| filepath | string  | yes      | Path to the file to print                |
| limit    | integer | no       | Maximum number of lines to print (0 = no limit) |

## Entrypoint

`index.ts` exports `runWith(ctx)` and `default` (the runner's `ExecutionContext` contract).

## Settings

- Concurrency: 4
- Category: fs
