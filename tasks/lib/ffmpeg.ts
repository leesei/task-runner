import {
  accessSync,
  constants,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

/**
 * Shared helpers for the reencode task.
 *
 * Encoding is always VAAPI HEVC. There is no software fallback: a missing
 * ffmpeg binary, a missing render device, or an unusable device is an error
 * the operator can see and fix, not a silent change of encoder.
 */

export const DEFAULT_VAAPI_DEVICE = "/dev/dri/renderD128";
export const PROGRESS_INTERVAL_MS = 10_000;
export const ABORT_KILL_GRACE_MS = 5_000;

export interface FfmpegOptions {
  /** Override the PATH used to locate the ffmpeg binary (for tests). */
  path?: string;
}

export interface EncodeOptions extends FfmpegOptions {
  /** Directory used to resolve relative paths and as the subprocess cwd. */
  cwd?: string;
  /** Runner cancellation signal. ffmpeg receives SIGTERM, then SIGKILL. */
  signal?: AbortSignal;
  /** Override the progress log interval (tests). */
  progressIntervalMs?: number;
  /** Override the SIGTERM-to-SIGKILL grace period (tests). */
  abortGraceMs?: number;
}

export class FfmpegUnavailableError extends Error {
  constructor() {
    super(
      "ffmpeg CLI not found; install ffmpeg with VAAPI support (hevc_vaapi) to use the reencode task",
    );
    this.name = "FfmpegUnavailableError";
  }
}

export function findFfmpeg(options?: FfmpegOptions): string | null {
  return options?.path !== undefined
    ? Bun.which("ffmpeg", { PATH: options.path })
    : Bun.which("ffmpeg");
}

export interface ReencodeInput {
  input: string;
  output: string;
  vbitrate: number;
  fps?: number;
  acodec?: "aac" | "copy";
  abitrate?: number;
  device?: string;
  overwrite?: boolean;
}

export interface ReencodeParams {
  input: string;
  output: string;
  /** Video bitrate in kbps. */
  vbitrate: number;
  fps: number;
  acodec: "aac" | "copy";
  /** Audio bitrate in kbps; ignored when `acodec` is `copy`. */
  abitrate: number;
  device: string;
  overwrite: boolean;
}

/**
 * Apply defaults and resolve both paths against the instance working
 * directory. Paths that are already absolute are left unchanged.
 */
export function resolveReencodeParams(
  input: ReencodeInput,
  cwd: string = process.cwd(),
): ReencodeParams {
  if (!input || typeof input.input !== "string" || input.input.length === 0) {
    throw new Error("input path is required");
  }
  if (typeof input.output !== "string" || input.output.length === 0) {
    throw new Error("output path is required");
  }
  if (!Number.isInteger(input.vbitrate) || input.vbitrate <= 0) {
    throw new Error("vbitrate must be a positive integer (kbps)");
  }

  const acodec = input.acodec ?? "aac";
  if (acodec !== "aac" && acodec !== "copy") {
    throw new Error(`unsupported audio codec: ${acodec} (use aac or copy)`);
  }

  const fps = input.fps ?? 24;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error("fps must be a positive number");
  }

  const abitrate = input.abitrate ?? 96;
  if (!Number.isInteger(abitrate) || abitrate <= 0) {
    throw new Error("abitrate must be a positive integer (kbps)");
  }

  return {
    input: resolve(cwd, input.input),
    output: resolve(cwd, input.output),
    vbitrate: input.vbitrate,
    fps,
    acodec,
    abitrate,
    device: input.device ?? DEFAULT_VAAPI_DEVICE,
    overwrite: input.overwrite ?? false,
  };
}

/**
 * The class of ffmpeg settings this task always uses, independent of the
 * payload: hardware upload, HEVC Main, and a large muxing queue.
 */
export function buildFfmpegArgs(
  params: ReencodeParams,
  partPath: string,
): string[] {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-progress",
    "pipe:1",
    // The part path belongs to this task; stale copies are removed before
    // spawning, so overwriting it is always safe.
    "-y",
    "-vaapi_device",
    params.device,
    "-i",
    params.input,
    "-vf",
    `fps=${params.fps},format=nv12,hwupload`,
    "-c:v",
    "hevc_vaapi",
    "-profile:v",
    "main",
    "-b:v",
    `${params.vbitrate}k`,
    "-c:a",
    params.acodec,
  ];

  // `-b:a` is meaningless with `copy`; omitting it keeps ffmpeg from warning.
  if (params.acodec !== "copy") {
    args.push("-b:a", `${params.abitrate}k`);
  }

  args.push("-max_muxing_queue_size", "1024", partPath);
  return args;
}

/**
 * Sibling path ffmpeg writes to before the final rename. Keeping the original
 * extension lets ffmpeg infer the container/muxer from the file name.
 */
export function partPathFor(output: string): string {
  const extension = extname(output);
  return join(
    dirname(output),
    `${basename(output, extension)}.part${extension}`,
  );
}

function assertReadableFile(path: string, label: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`${label} is not a file: ${path}`);
  }
  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new Error(`${label} is not readable: ${path}`);
  }
}

/**
 * Validate the invocation before spawning ffmpeg and return the part path.
 * These checks turn common mistakes into a readable task failure instead of
 * an opaque ffmpeg exit code.
 */
export function prepareReencode(params: ReencodeParams): string {
  if (params.output === params.input) {
    throw new Error("output must differ from input");
  }

  if (extname(params.output).length === 0) {
    throw new Error(
      `output must have a file extension so ffmpeg can infer the container: ${params.output}`,
    );
  }

  assertReadableFile(params.input, "input");

  const partPath = partPathFor(params.output);
  if (partPath === params.input) {
    throw new Error(
      `input conflicts with the temporary output file: ${partPath} (rename the input or choose another output)`,
    );
  }

  try {
    statSync(params.device);
  } catch {
    throw new Error(`VAAPI device not found: ${params.device}`);
  }
  try {
    accessSync(params.device, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(
      `VAAPI device is not readable and writable: ${params.device} (check the render group permissions)`,
    );
  }

  const outputDir = dirname(params.output);
  let dirStats;
  try {
    dirStats = statSync(outputDir);
  } catch {
    throw new Error(`output directory does not exist: ${outputDir}`);
  }
  if (!dirStats.isDirectory()) {
    throw new Error(`output directory is not a directory: ${outputDir}`);
  }
  try {
    accessSync(outputDir, constants.W_OK);
  } catch {
    throw new Error(`output directory is not writable: ${outputDir}`);
  }

  if (!params.overwrite && existsSync(params.output)) {
    throw new Error(
      `output already exists: ${params.output} (pass overwrite:=true to replace it)`,
    );
  }

  return partPath;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) onLine(line);
      newline = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  const line = buffer.replace(/\r$/, "");
  if (line.length > 0) onLine(line);
}

/**
 * Parse ffmpeg's `-progress pipe:1` key/value blocks and log a compact line
 * every `intervalMs`, plus the final block. ffmpeg's normal stats use `\r`,
 * which is unusable as JSONL log lines.
 */
function createProgressLogger(intervalMs: number) {
  const state = new Map<string, string>();
  let lastLog = 0;
  let ended = false;

  const emit = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastLog < intervalMs) return;
    lastLog = now;

    const parts: string[] = [];
    for (const key of [
      "frame",
      "fps",
      "speed",
      "out_time",
      "bitrate",
      "total_size",
    ]) {
      const value = state.get(key);
      if (value !== undefined && value !== "N/A") parts.push(`${key}=${value}`);
    }
    if (parts.length > 0) console.log(`reencode: progress ${parts.join(" ")}`);
  };

  return {
    onLine(line: string): void {
      const separator = line.indexOf("=");
      if (separator < 0) return;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      state.set(key, value);

      if (key === "progress") {
        ended = value === "end";
        emit(ended);
      }
    },
    finish(): void {
      if (!ended) emit(true);
    },
  };
}

/**
 * Run one VAAPI HEVC encode. Returns the task exit code; 124 means the
 * runner's signal aborted the process.
 *
 * The output is written to a sibling `.part` file and renamed on success, so
 * a failure or abort never leaves a plausible-looking final output.
 */
export async function encode(
  params: ReencodeParams,
  options?: EncodeOptions,
): Promise<number> {
  const ffmpeg = findFfmpeg(options);
  if (!ffmpeg) {
    throw new FfmpegUnavailableError();
  }

  const partPath = prepareReencode(params);
  const args = buildFfmpegArgs(params, partPath);

  // A stale part file from a crash must not block the new attempt.
  rmSync(partPath, { force: true });

  if (options?.signal?.aborted) return 124;

  console.log(`reencode: ${ffmpeg} ${args.join(" ")}`);

  const progressInterval = options?.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const abortGrace = options?.abortGraceMs ?? ABORT_KILL_GRACE_MS;

  let killProcess: (() => void) | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    if (killTimer !== undefined) return;
    // Bun's spawn signal sends SIGTERM. A stuck VAAPI process gets SIGKILL
    // after the grace period.
    killTimer = setTimeout(() => {
      killProcess?.();
    }, abortGrace);
  };
  options?.signal?.addEventListener("abort", onAbort, { once: true });

  let succeeded = false;
  try {
    const proc = Bun.spawn({
      cmd: [ffmpeg, ...args],
      cwd: options?.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: options?.signal,
    });
    killProcess = (): void => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // The process already exited.
      }
    };
    if (options?.signal?.aborted) onAbort();

    const progress = createProgressLogger(progressInterval);
    const stderrDone = readLines(proc.stderr, (line) => {
      console.error(`ffmpeg: ${line}`);
    });
    const stdoutDone = readLines(proc.stdout, (line) => {
      progress.onLine(line);
    });

    const [exitCode] = await Promise.all([
      proc.exited,
      stdoutDone,
      stderrDone,
    ]);
    progress.finish();

    if (options?.signal?.aborted) {
      console.error("reencode: aborted");
      return 124;
    }
    if (exitCode !== 0) {
      console.error(`reencode: ffmpeg exited with code ${exitCode}`);
      return exitCode;
    }

    renameSync(partPath, params.output);
    succeeded = true;
    console.log(`reencode: wrote ${params.output}`);
    return 0;
  } finally {
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    options?.signal?.removeEventListener("abort", onAbort);
    if (!succeeded) {
      rmSync(partPath, { force: true });
    }
  }
}
