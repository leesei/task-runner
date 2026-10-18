import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function sha256(filepath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filepath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
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
    const digest = await sha256(ctx.input.filepath);
    console.log(digest);
    ctx.done(0);
  } catch (err: any) {
    if (ctx.signal.aborted) {
      ctx.done(124);
      return;
    }
    console.error(`sha256: ${err?.message ?? err}`);
    ctx.done(1);
  }
}

export default runWith;
