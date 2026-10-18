# 01: Bootstrap daemon process, CLI binary, and data directory

**What to build:** A Bun project that builds to a `tq` binary and starts a long-lived daemon process. `tq daemon` starts an HTTP server on a configurable port with a configurable data directory, writes a daemon descriptor file (pid + port) into the data directory, and removes it on clean shutdown. `tq --help` and `tq daemon --help` print usage. A port conflict is a startup error. The data directory holds a SQLite database, a log directory, and the descriptor file; default is `.tq/` in the working directory, overridable by `--data-dir` flag and `TQ_DATA_DIR` env var. `--port` flag and `TQ_PORT` env var control the HTTP port; `--port 0` binds an ephemeral port.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] `bun run build` produces a `tq` binary at the project root
- [ ] `./tq --help` prints usage for all commands
- [ ] `./tq daemon --help` prints daemon-specific flags
- [ ] `./tq daemon` starts an HTTP server on localhost:3000 by default
- [ ] `./tq daemon --data-dir /tmp/tq-test --port 0` starts with custom data dir and ephemeral port
- [ ] A port conflict causes a clear startup error and exit non-zero
- [ ] The daemon writes `.tq/daemon.json` (or equivalent) with pid, port, dataDir, startedAt on start
- [ ] The daemon removes the descriptor on clean shutdown (SIGINT/SIGTERM)
- [ ] `--data-dir` and `--port` flags take precedence over env vars, which take precedence over defaults
