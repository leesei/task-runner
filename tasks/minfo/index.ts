import { getMediainfo, printMediaInfo } from "../lib/media.ts";

export async function minfo(filepath: string) {
  const minfoData = await getMediainfo(filepath);
  if (!minfoData) return -1;
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
  } catch (err) {
    console.error(err);
    ctx.done(1);
  }
}

export default runWith;
