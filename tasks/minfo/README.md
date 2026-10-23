# minfo

Prints media information (duration, video/audio format, resolution, bitrate) for a video/audio file using `mediainfo`.

## Usage

```sh
tq add default:minfo <filepath>
tq add default:minfo '{"filepath":"fixture/1/1.srt"}'
```

## Input

| Field    | Type   | Required | Description                                          |
| -------- | ------ | -------- | ---------------------------------------------------- |
| filepath | string | yes      | Path to the media file (absolute or relative to cwd) |

## Settings

- Concurrency: 1 (media analysis is typically CPU-bound; run one at a time)

## Entrypoint

`index.ts` exports `runWith(ctx)` and `default` (the runner's `ExecutionContext` contract).

## Shared modules

Uses helpers from the same package via `../lib/media.ts`: `getMediainfo`, `printMediaInfo`. In a multi-task package these live in a shared `lib/` at the package root and are imported via relative path.
