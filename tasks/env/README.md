# env

Dumps environment variables, with sensitive values redacted.

By default, values are shown but any variable whose name or value looks sensitive is redacted to `[REDACTED]`. Use `filter` to scope to a prefix (e.g. `TASKRUNNER_`) and `values: false` to show names only.

## Usage

```sh
tq add default:env
tq add default:env '{"filter":"TASKRUNNER"}'
tq add default:env '{"filter":"TASKRUNNER","values":false}'
```

## Input

| Field   | Type    | Required | Description                                               |
|---------|---------|----------|-----------------------------------------------------------|
| filter  | string  | no       | Only show env vars whose name starts with this prefix     |
| values  | boolean | no       | Show values (default true; sensitive values always redacted) |

## Entrypoint

`index.ts` exports `runWith(ctx)` and `default` (the runner's `ExecutionContext` contract).

## Settings

- Concurrency: 8
- Category: text
