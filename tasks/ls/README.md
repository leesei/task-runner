# ls

Lists the contents of a directory using the system `ls` command.

## Usage

```sh
tq add default:ls <directory>
tq add default:ls '{"filepath":"fixture/1"}'
```

## Input

| Field    | Type   | Required | Description             |
|----------|--------|----------|-------------------------|
| filepath | string | yes      | Directory path to list  |

## Settings

- Concurrency: 4

## Entrypoint

`index.ts` exports `runWith(ctx)` and `default` (the runner's `ExecutionContext` contract).

## Implementation

Thin wrapper around the system `ls`. Captures stdout/stderr and returns the exit code.
