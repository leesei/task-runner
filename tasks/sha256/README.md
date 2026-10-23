# sha256

Computes the SHA-256 digest of a file and prints the hex-encoded hash.

## Usage

```sh
tq add default:sha256 <filepath>
tq add default:sha256 '{"filepath":"fixture/1/1.srt"}'
```

## Input

| Field    | Type   | Required | Description              |
|----------|--------|----------|--------------------------|
| filepath | string | yes      | Path to the file to hash |

## Settings

- Concurrency: 2 (IO-bound on large files)
- Category: fs
- Timeout: 30 minutes (`timeoutMs: 1800000`)

## Entrypoint

`index.ts` exports `runWith(ctx)` and `default` (the runner's `ExecutionContext` contract).

## Implementation

Pure Bun/Node crypto (`node:crypto.createHash('sha256')`), streamed so large files don't load entirely into memory.
