# task-runner

A task runner with a daemon, allow user to add tasks, tasks are extensible, with a web dashboard, use CLI and dashboard to manage tasks.

## Requirements

- Bun v1.4.2+

```sh
bun install
```

## Usage

One entry point, start daamon first, then use the command the manage the queues and daemon.

| Command                    | Behavior                                                            |
| -------------------------- | ------------------------------------------------------------------- |
| `tq daemon`                | Start the HTTP server, dashboard, and runner loop; queues autostart |
| `tq add <task> [context]`  | Validate context, enqueue, print id/time/task/context               |
| `tq start <queue>`         | Begin draining pending instances                                    |
| `tq stop <queue>`          | Finish running instances, start nothing new                         |
| `tq abort <queue>`         | Cancel running instances back to PENDING, leave the queue stopped   |
| `tq clear [--all] <queue>` | Delete SUCCESS instances (or all finished instances) and their logs |
| `tq status`                | Print queue state, concurrency, running, and pending counts         |
| `tq logs <instance-id>`    | Print the merged stdout/stderr log                                  |
| `tq install <package>`     | Install a task package and record it in the lockfile                |
| `tq reload`                | Re-read task definitions and apply changes                          |

## Examples

```sh
tq add task ...

```

## Configurations

table of exports

## Docs

- `docs/SPECS.md`: what task runner is specified to do
- `docs/DESIGN.md`: how the daemon, database and each sub command works — protocol mechanics, design choices, internals, limitations, references
- `docs/adr/`: Architecture Decision Record (ADR)
- `GLOSSARY.md`: the project's vocabulary
- `.scratch/<feature>/issues/`: implementation task to be completed
