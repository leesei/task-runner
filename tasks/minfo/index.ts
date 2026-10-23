import {
  getMediainfo,
  printMediaInfo,
  type MediaOptions,
} from "../lib/media.ts";

export async function minfo(filepath: string, options?: MediaOptions) {
  const minfoData = await getMediainfo(filepath, options);
  printMediaInfo(minfoData, { debug: true });
  return 0;
}

export async function runWith(ctx: {
  input: { filepath: string };
  signal: AbortSignal;
  done: (exitCode: number) => void;
}) {
  try {
    if (ctx.signal.aborted) {
      ctx.done(124);
      return;
    }
    const exitCode = await minfo(ctx.input.filepath);
    ctx.done(exitCode);
  } catch (err: any) {
    if (ctx.signal.aborted) {
      ctx.done(124);
      return;
    }
    console.error(`minfo: ${err?.message ?? err}`);
    ctx.done(1);
  }
}

export default runWith;
