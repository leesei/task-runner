# reencode

Reencodes a video to HEVC with VAAPI hardware encoding. The encoder is always
`hevc_vaapi` with `-profile:v main`; there is no software fallback.

The ffmpeg invocation is:

```sh
ffmpeg \
  -vaapi_device <device> \
  -i <input> \
  -vf "fps=<fps>,format=nv12,hwupload" \
  -c:v hevc_vaapi -profile:v main -b:v <vbitrate>k \
  -c:a <acodec> -b:a <abitrate>k \
  -max_muxing_queue_size 1024 <output>
```

## Usage

`vbitrate` is an integer (kbps), so the CLI assignment form needs `:=`:

```sh
tq add default:reencode input=in.mp4 output=out.mp4 vbitrate:=850
tq add default:reencode input=in.mp4 output=out.mp4 vbitrate:=850 fps:=24
tq add default:reencode input=in.mp4 output=out.mp4 vbitrate:=850 acodec=copy
tq add default:reencode input=in.mp4 output=out.mp4 vbitrate:=850 overwrite:=true
tq add default:reencode '{"input":"in.mp4","output":"out.mp4","vbitrate":850,"acodec":"aac","abitrate":96}'
```

The output name is treated as disposable: a typical workflow encodes to a
temporary name and renames it after inspecting the result.

## Input

| Field     | Type    | Required | Default                 | Description                                             |
| --------- | ------- | -------- | ----------------------- | ------------------------------------------------------- |
| input     | string  | yes      | —                       | Source video file                                       |
| output    | string  | yes      | —                       | Destination video file; must have an extension          |
| vbitrate  | integer | yes      | —                       | Video bitrate in kbps                                   |
| fps       | number  | no       | 24                      | Output frame rate                                       |
| acodec    | string  | no       | `aac`                   | `aac` or `copy` (copy keeps the source audio stream)    |
| abitrate  | integer | no       | 96                      | Audio bitrate in kbps; ignored when `acodec` is `copy`  |
| device    | string  | no       | `/dev/dri/renderD128`   | VAAPI render device                                     |
| overwrite | boolean | no       | `false`                 | Replace an existing output file                         |

Relative paths resolve against the instance working directory (`ctx.cwd`) and,
for the CLI, are stored as absolute paths by `tq add`.

## Output behavior

- ffmpeg writes to a sibling part file (`<stem>.part<ext>`), which is renamed
  to `output` only after a successful exit. A failed, aborted, or timed-out
  attempt deletes the part file, so a retry is never blocked by partial data.
- A stale part file from a previous crash is removed before encoding starts.
- An existing `output` is an error unless `overwrite` is `true`; ffmpeg itself
  is told to overwrite the part file with `-y`.
- The output parent directory must already exist. Missing directories are an
  error, not created implicitly.
- `output` must differ from `input` and must have a file extension.
- Aborting sends `SIGTERM` to ffmpeg, then `SIGKILL` after five seconds.

## Settings

- Concurrency: 1 (a single render device, one encode at a time)
- Category: media
- Timeout: 30 minutes (`timeoutMs: 1800000`)

## Requirements

- `ffmpeg` on `PATH`, built with the `hevc_vaapi` encoder.
- Read/write access to the VAAPI render device (usually membership in the
  `render` group). A missing binary or inaccessible device fails with a clear
  message instead of falling back to software encoding.

## Logging

The task logs the exact argv, forwards ffmpeg's stderr, and emits a compact
progress line every 10 seconds plus the final block (`frame`, `fps`, `speed`,
`out_time`, `bitrate`, `total_size`). ffmpeg's default `\r` stats are disabled
with `-nostats` because they are unusable as log lines.

## Entrypoint

`index.ts` exports `runWith(ctx)` and `default` (the runner's
`ExecutionContext` contract). The encoding helpers live in
`tasks/lib/ffmpeg.ts`; the pure `buildFfmpegArgs` function is covered by unit
tests.
