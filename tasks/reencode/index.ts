import {
  encode,
  resolveReencodeParams,
  type EncodeOptions,
  type ReencodeInput,
} from "../lib/ffmpeg.ts";

/**
 * Reencode a video to HEVC with VAAPI hardware encoding.
 *
 * Exposed separately from `runWith` so the task logic can be called directly
 * in tests without the runner's completion callback.
 */
export async function reencode(
  input: ReencodeInput,
  options?: EncodeOptions,
): Promise<number> {
  const params = resolveReencodeParams(input, options?.cwd);
  return encode(params, options);
}

export async function runWith(ctx: {
  input: ReencodeInput;
  cwd: string;
  signal: AbortSignal;
  done: (exitCode: number) => void;
}) {
  try {
    if (ctx.signal.aborted) {
      ctx.done(124);
      return;
    }
    const exitCode = await reencode(ctx.input, {
      cwd: ctx.cwd,
      signal: ctx.signal,
    });
    ctx.done(exitCode);
  } catch (err: any) {
    if (ctx.signal.aborted) {
      ctx.done(124);
      return;
    }
    console.error(`reencode: ${err?.message ?? err}`);
    ctx.done(1);
  }
}

export default runWith;
