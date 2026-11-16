# 20: Reencode a video to HEVC with VAAPI hardware encoding

**Status:** done

**Blocked by:** None

## Problem Statement

The repo has media inspection (`minfo`) but no task that produces a new file. The
reencode workflow currently lives in a personal script (`gtm-reencode.ts` in another
project) that picks a bitrate from the resolution, defaults the output name to
`output_hevc.mp4`, and then requires a manual `mv`. It cannot be queued, aborted,
retried, or observed through the task runner, and its ffmpeg output is not captured in
the instance log.

## Solution

Add a `default:reencode` task that takes both paths and the encoding parameters in its
context and always encodes with VAAPI HEVC (`hevc_vaapi`, `-profile:v main`). The
context is validated by the existing schema path, so the CLI and HTTP surfaces reject
the same bad values. The task writes to a sibling part file and renames it only after a
successful exit; an existing output is refused unless `overwrite` is set; a failure,
abort, or timeout removes the part file. ffmpeg output is captured: the exact argv, the
stderr stream, and a compact progress line every 10 seconds.

## User Stories

1. As a CLI user, I want to enqueue a reencode with `tq add default:reencode input=... output=... vbitrate:=850`, so that encoding runs through the queue instead of a foreground shell.
2. As a CLI user, I want the paths resolved against my invocation directory, so that relative paths target the files I can see.
3. As a CLI user, I want an existing output refused by default, so that a mistyped output name cannot destroy a file.
4. As a CLI user, I want `overwrite:=true` to replace an existing output, so that an intentional rerun works.
5. As a CLI user, I want a failed or aborted encode to leave no part file, so that the next attempt is not blocked by partial data.
6. As a CLI user, I want `output` to differ from `input`, so that an encode cannot truncate its own source.
7. As a CLI user, I want a missing output directory to fail with a clear message, so that I fix the path rather than wonder why ffmpeg failed.
8. As a CLI user, I want `acodec=copy` to keep the source audio without a bitrate argument, so that audio is not needlessly re-encoded.
9. As a CLI user, I want the task to use the `render` device by default, so that I do not have to pass it every time.
10. As a CLI user on another machine, I want to override the device, so that `renderD129` works without editing the task.
11. As a CLI user, I want a missing ffmpeg or inaccessible device to fail clearly, so that I know hardware encoding is unavailable and no software fallback happened.
12. As an operator, I want the task to log the exact ffmpeg argv, so that a run is reproducible.
13. As an operator, I want ffmpeg's warnings and errors in the instance log, so that a failure is diagnosable.
14. As an operator, I want a progress line at most every 10 seconds, so that a long encode is observable without flooding the JSONL log.
15. As an operator, I want an abort to stop ffmpeg with `SIGTERM` and then `SIGKILL`, so that a stuck VAAPI process does not keep a CPU/GPU slot busy.
16. As an operator, I want one encode at a time, so that instances do not contend for the single render device.
17. As a task author, I want a pure `buildFfmpegArgs` function, so that the fixed flags and conditional `-b:a` are unit-testable without hardware.
18. As a task author, I want the ffmpeg helpers in `tasks/lib/ffmpeg.ts`, so that other ffmpeg tasks can reuse them.
19. As a maintainer, I want the task to use `Bun.spawn`, so that the runner's `AbortSignal` kills the child and no new dependency is needed.
20. As a maintainer, I want fake-binary tests, so that success, failure, overwrite, and abort paths run in CI without VAAPI hardware.

## Implementation Decisions

### Domain vocabulary

- Add **Context** to `GLOSSARY.md`: the JSON value accepted by `tq add`/HTTP, validated against the input schema and stored on the instance. "Payload" and "params" are avoided in the task docs.

### Task definition

- Folder `tasks/reencode/`, `namespace: "default"`, `id: "reencode"`, category `media`, concurrency `1`, timeout `1800000` (30 minutes, the repo default).
- Required context: `input` and `output` (`format: "path"`), `vbitrate` (integer kbps).
- Optional context with defaults: `fps` (24), `acodec` (`aac`), `abitrate` (96), `device` (`/dev/dri/renderD128`), `overwrite` (`false`).
- Fixed flags: `hevc_vaapi`, `-profile:v main`, `-vf "fps=<fps>,format=nv12,hwupload"`, `-max_muxing_queue_size 1024`, `-hide_banner -nostdin -nostats -progress pipe:1 -y`.
- `-b:a` is omitted when `acodec` is `copy`.
- No bitrate/fps derivation from `mediainfo`: the context is the source of truth.

### Output handling

- Encode to `<stem>.part<ext>` in the same directory, then `renameSync` to `output` only on exit code 0.
- A stale part file is removed before spawning.
- `output` must differ from `input`, must not equal the part path, and must have an extension (the muxer is inferred from it).
- The output parent directory must exist and be writable; it is not created.
- An existing `output` fails before spawning unless `overwrite` is true.
- Failure, abort (124), and timeout remove the part file.

### Execution

- `Bun.spawn` with `signal`, `cwd: ctx.cwd`, `stdin: "ignore"`, piped stdout/stderr. No new dependency; `fluent-ffmpeg` would only wrap the same binary.
- `findFfmpeg()` mirrors the `mediainfo` helper: `Bun.which`, with a `PATH` override for tests.
- Preflight checks the input file, the device, and the output directory before spawning.
- On abort, ffmpeg gets `SIGTERM` from the spawn signal and `SIGKILL` after 5 seconds; the task returns 124.
- Progress is parsed from `-progress pipe:1`; a summary is logged every 10 seconds and on the final `progress=end`.
- stderr lines are forwarded through `console.error` so the runner's console interception captures them.

## Checklist

- [x] `tasks/reencode/` has `index.ts`, `README.md`, `settings.json`, `schema.json`
- [x] `tasks/lib/ffmpeg.ts` exports `findFfmpeg`, `resolveReencodeParams`, `buildFfmpegArgs`, `prepareReencode`, and `encode`
- [x] Schema marks both paths as `format: "path"`, requires `input`/`output`/`vbitrate`, and constrains `acodec` to `aac`/`copy`
- [x] Existing output refused unless `overwrite` is true
- [x] Part file renamed on success and removed on failure/abort
- [x] Missing ffmpeg, device, input, output directory, extension, and same-path input produce clear errors
- [x] `tests/reencode-task.test.ts` covers the arg builder, success, failure, overwrite, stale part, abort, and preflight errors
- [x] Real-VAAPI integration test is opt-in behind `TQ_TEST_VAAPI=1` and skipped without a render device
- [x] `tests/sample-tasks.test.ts` includes the reencode folder contract and schema assertions
- [x] `GLOSSARY.md` defines **Context**

## Comments

- Implementation was designed in a grilling session on 2026-11-16. Decisions: part file restored after an initial "use the output directly" answer; 30-minute timeout kept; `overwrite` retained.
- The fake-ffmpeg tests use a temp `bin/ffmpeg` shell script and a regular file as the render device, so no VAAPI hardware is required. The fake must `exec` its long-running child so the abort test exercises the runner's signal the way a real (single-process) ffmpeg does.
- Opt-in hardware test: `TQ_TEST_VAAPI=1 bun test tests/reencode-task.test.ts` on this machine (`/dev/dri/renderD128`) produced HEVC Main at 24 fps from a generated 1-second clip. Override the node with `TQ_VAAPI_DEVICE`.
- CLI smoke test: `tq add default:reencode input=... output=... vbitrate:=300 acodec=copy` stored the defaults and absolute paths, and a real daemon run wrote the output and logged argv, stderr, and the final progress block.
- Evidence: `bun test` -> 177 pass / 1 skip / 0 fail (178 tests across 17 files); `bunx tsc --noEmit` clean.
