import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_VAAPI_DEVICE,
  buildFfmpegArgs,
  encode,
  FfmpegUnavailableError,
  partPathFor,
  resolveReencodeParams,
  type ReencodeInput,
  type ReencodeParams,
} from "../tasks/lib/ffmpeg.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface Fixture {
  dir: string;
  input: string;
  output: string;
  device: string;
}

function makeFixture(): Fixture {
  const dir = makeTempDir("tq-reencode-");
  const input = join(dir, "in.mp4");
  writeFileSync(input, "input");
  // A regular file stands in for the render device; preflight only checks
  // that the path exists and is readable/writable.
  const device = join(dir, "renderD128");
  writeFileSync(device, "device");
  return { dir, input, output: join(dir, "out.mp4"), device };
}

const SUCCESS_SCRIPT = `
printf fake > "$last"
printf 'frame=10\\nfps=24.00\\nspeed=1.5x\\nout_time=00:00:01.000000\\nbitrate=850.0kbits/s\\nprogress=end\\n'
exit 0
`;

const FAILURE_SCRIPT = `
printf partial > "$last"
exit 2
`;

const ABORT_SCRIPT = `
printf partial > "$last"
exec sleep 5
`;

/**
 * Write a fake `ffmpeg` into `<dir>/bin`, plus an args recorder. The script
 * treats its last argument as the output and records `$@` in `args.txt`.
 */
function makeFakeFfmpeg(dir: string, tail: string): string {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const argsFile = join(dir, "args.txt");
  const script = `#!/bin/sh
printf '%s\\n' "$@" > ${shellQuote(argsFile)}
for last in "$@"; do :; done
${tail}
`;
  const bin = join(binDir, "ffmpeg");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return binDir;
}

function readArgs(dir: string): string[] {
  return readFileSync(join(dir, "args.txt"), "utf-8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function makeParams(
  fixture: Fixture,
  overrides: Partial<ReencodeInput> = {},
): ReencodeParams {
  return resolveReencodeParams(
    {
      input: fixture.input,
      output: fixture.output,
      vbitrate: 850,
      device: fixture.device,
      ...overrides,
    },
    fixture.dir,
  );
}

describe("resolveReencodeParams", () => {
  test("applies defaults and resolves relative paths", () => {
    const params = resolveReencodeParams(
      { input: "in.mp4", output: "out.mp4", vbitrate: 850 },
      "/work",
    );

    expect(params.input).toBe("/work/in.mp4");
    expect(params.output).toBe("/work/out.mp4");
    expect(params.fps).toBe(24);
    expect(params.acodec).toBe("aac");
    expect(params.abitrate).toBe(96);
    expect(params.device).toBe(DEFAULT_VAAPI_DEVICE);
    expect(params.overwrite).toBe(false);
  });

  test("keeps absolute paths unchanged", () => {
    const fixture = makeFixture();
    const params = resolveReencodeParams(
      {
        input: fixture.input,
        output: fixture.output,
        vbitrate: 850,
        device: fixture.device,
      },
      "/somewhere/else",
    );

    expect(params.input).toBe(fixture.input);
    expect(params.output).toBe(fixture.output);
  });
});

describe("buildFfmpegArgs", () => {
  test("always encodes HEVC with VAAPI and profile main", () => {
    const fixture = makeFixture();
    const params = makeParams(fixture);
    const part = partPathFor(fixture.output);
    const args = buildFfmpegArgs(params, part);

    expect(args[0]).toBe("-hide_banner");
    expect(args).toContain("-nostdin");
    expect(args[args.indexOf("-vaapi_device") + 1]).toBe(fixture.device);
    expect(args[args.indexOf("-i") + 1]).toBe(fixture.input);
    expect(args[args.indexOf("-vf") + 1]).toBe("fps=24,format=nv12,hwupload");
    expect(args[args.indexOf("-c:v") + 1]).toBe("hevc_vaapi");
    expect(args[args.indexOf("-profile:v") + 1]).toBe("main");
    expect(args[args.indexOf("-b:v") + 1]).toBe("850k");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args[args.indexOf("-b:a") + 1]).toBe("96k");
    expect(args[args.indexOf("-max_muxing_queue_size") + 1]).toBe("1024");
    expect(args).toContain("-y");
    expect(args[args.length - 1]).toBe(part);
  });

  test("omits the audio bitrate when the audio is copied", () => {
    const fixture = makeFixture();
    const params = makeParams(fixture, { acodec: "copy" });
    const args = buildFfmpegArgs(params, partPathFor(fixture.output));

    expect(args[args.indexOf("-c:a") + 1]).toBe("copy");
    expect(args).not.toContain("-b:a");
  });
});

describe("encode", () => {
  test("renames the part file and records the expected arguments", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, SUCCESS_SCRIPT);
    const part = partPathFor(fixture.output);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    let code: number;
    try {
      code = await encode(makeParams(fixture), {
        path: binDir,
        cwd: fixture.dir,
      });
    } finally {
      console.log = originalLog;
    }

    expect(code).toBe(0);
    expect(readFileSync(fixture.output, "utf-8")).toBe("fake");
    expect(existsSync(part)).toBe(false);

    const args = readArgs(fixture.dir);
    expect(args).toContain("-y");
    expect(args[args.length - 1]).toBe(part);
    expect(logs.join("\n")).toContain("reencode: progress");
    expect(logs.join("\n")).toContain("frame=10");
  });

  test("removes the part file and reports the exit code on failure", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, FAILURE_SCRIPT);

    const code = await encode(makeParams(fixture), {
      path: binDir,
      cwd: fixture.dir,
    });

    expect(code).toBe(2);
    expect(existsSync(partPathFor(fixture.output))).toBe(false);
    expect(existsSync(fixture.output)).toBe(false);
  });

  test("refuses an existing output unless overwrite is set", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, SUCCESS_SCRIPT);
    writeFileSync(fixture.output, "old");

    await expect(
      encode(makeParams(fixture), { path: binDir, cwd: fixture.dir }),
    ).rejects.toThrow(/already exists/);

    expect(readFileSync(fixture.output, "utf-8")).toBe("old");
    expect(existsSync(join(fixture.dir, "args.txt"))).toBe(false);
  });

  test("replaces an existing output when overwrite is set", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, SUCCESS_SCRIPT);
    writeFileSync(fixture.output, "old");

    const code = await encode(makeParams(fixture, { overwrite: true }), {
      path: binDir,
      cwd: fixture.dir,
    });

    expect(code).toBe(0);
    expect(readFileSync(fixture.output, "utf-8")).toBe("fake");
  });

  test("removes a stale part file before encoding", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, SUCCESS_SCRIPT);
    const part = partPathFor(fixture.output);
    writeFileSync(part, "stale");

    const code = await encode(makeParams(fixture), {
      path: binDir,
      cwd: fixture.dir,
    });

    expect(code).toBe(0);
    expect(readFileSync(fixture.output, "utf-8")).toBe("fake");
    expect(existsSync(part)).toBe(false);
  });

  test("aborts the child and removes the part file", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, ABORT_SCRIPT);
    const controller = new AbortController();

    const pending = encode(makeParams(fixture), {
      path: binDir,
      cwd: fixture.dir,
      signal: controller.signal,
      abortGraceMs: 100,
    });
    await Bun.sleep(150);
    controller.abort();

    expect(await pending).toBe(124);
    expect(existsSync(partPathFor(fixture.output))).toBe(false);
    expect(existsSync(fixture.output)).toBe(false);
  });

  test("fails clearly when ffmpeg is missing", async () => {
    const fixture = makeFixture();
    const emptyDir = makeTempDir("tq-reencode-empty-");

    await expect(
      encode(makeParams(fixture), { path: emptyDir, cwd: fixture.dir }),
    ).rejects.toBeInstanceOf(FfmpegUnavailableError);
  });

  test("fails clearly when the input is missing", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, SUCCESS_SCRIPT);

    await expect(
      encode(makeParams(fixture, { input: join(fixture.dir, "missing.mp4") }), {
        path: binDir,
        cwd: fixture.dir,
      }),
    ).rejects.toThrow(/input does not exist/);
  });

  test("rejects an output without an extension", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, SUCCESS_SCRIPT);

    await expect(
      encode(makeParams(fixture, { output: join(fixture.dir, "out") }), {
        path: binDir,
        cwd: fixture.dir,
      }),
    ).rejects.toThrow(/file extension/);
  });

  test("rejects an output equal to the input", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, SUCCESS_SCRIPT);

    await expect(
      encode(makeParams(fixture, { output: fixture.input }), {
        path: binDir,
        cwd: fixture.dir,
      }),
    ).rejects.toThrow(/must differ/);
  });

  test("rejects a missing output directory", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, SUCCESS_SCRIPT);

    await expect(
      encode(
        makeParams(fixture, { output: join(fixture.dir, "missing", "out.mp4") }),
        { path: binDir, cwd: fixture.dir },
      ),
    ).rejects.toThrow(/output directory does not exist/);
  });

  test("rejects a missing VAAPI device", async () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, SUCCESS_SCRIPT);

    await expect(
      encode(
        makeParams(fixture, { device: join(fixture.dir, "missing-device") }),
        { path: binDir, cwd: fixture.dir },
      ),
    ).rejects.toThrow(/VAAPI device not found/);
  });
});

describe("reencode task entrypoint", () => {
  test("wires ctx through the fake ffmpeg found on PATH", () => {
    const fixture = makeFixture();
    const binDir = makeFakeFfmpeg(fixture.dir, SUCCESS_SCRIPT);
    const script = `
      import run from ${JSON.stringify(join(process.cwd(), "tasks/reencode/index.ts"))};
      let exitCode;
      await run({
        input: {
          input: ${JSON.stringify(fixture.input)},
          output: ${JSON.stringify(fixture.output)},
          vbitrate: 850,
        },
        cwd: ${JSON.stringify(fixture.dir)},
        signal: new AbortController().signal,
        done: (code) => { exitCode = code; },
      });
      process.exit(exitCode ?? 0);
    `;

    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(fixture.output)).toBe(true);
    expect(result.stdout.toString()).toContain("reencode: progress");
  });
});

// Opt-in: a real hardware encode. It is skipped unless TQ_TEST_VAAPI=1 and the
// device exists, so CI and machines without a render node are unaffected.
const VAAPI_DEVICE = process.env.TQ_VAAPI_DEVICE ?? DEFAULT_VAAPI_DEVICE;
const vaapiIntegration =
  process.env.TQ_TEST_VAAPI === "1" &&
  existsSync(VAAPI_DEVICE) &&
  Bun.which("ffmpeg") !== null &&
  Bun.which("ffprobe") !== null;

describe("reencode on real VAAPI hardware", () => {
  test.skipIf(!vaapiIntegration)(
    "produces an HEVC Main output at the requested frame rate",
    async () => {
      const dir = makeTempDir("tq-reencode-vaapi-");
      const input = join(dir, "in.mp4");
      const output = join(dir, "out.mp4");

      const generated = Bun.spawnSync({
        cmd: [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=320x240:rate=30",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=44100",
          "-t",
          "1",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          input,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(generated.exitCode).toBe(0);

      const code = await encode(
        resolveReencodeParams(
          {
            input,
            output,
            vbitrate: 300,
            fps: 24,
            acodec: "copy",
            device: VAAPI_DEVICE,
          },
          dir,
        ),
      );
      expect(code).toBe(0);
      expect(existsSync(partPathFor(output))).toBe(false);

      const probe = Bun.spawnSync({
        cmd: [
          "ffprobe",
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=codec_name,profile,r_frame_rate",
          "-of",
          "json",
          output,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(probe.exitCode).toBe(0);

      const streams = JSON.parse(probe.stdout.toString()).streams;
      expect(streams[0].codec_name).toBe("hevc");
      expect(streams[0].profile).toBe("Main");
      expect(streams[0].r_frame_rate).toBe("24/1");
    },
  );
});
