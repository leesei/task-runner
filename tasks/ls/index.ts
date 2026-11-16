import { $ } from "bun";

export async function ls(filepath: string) {
  const { stdout, stderr, exitCode } = await $`ls ${filepath}`
    .nothrow()
    .quiet();
  if (stdout) console.log(stdout.toString());
  if (stderr) console.error(stderr.toString());
  return exitCode === null ? 0 : exitCode;
}

/**
 * Task entrypoint for the runner's ExecutionContext contract.
 * Wraps the plain `ls(filepath)` function so the runner can capture logs
 * and drive state transitions.
 */
export async function runWith(ctx: {
  input: { filepath?: string };
  cwd: string;
  signal: AbortSignal;
  done: (exitCode: number) => void;
}) {
  try {
    if (ctx.signal.aborted) {
      ctx.done(124);
      return;
    }
    const exitCode = await ls(ctx.input.filepath ?? ctx.cwd);
    ctx.done(exitCode);
  } catch (err) {
    console.error(err);
    ctx.done(1);
  }
}

export default runWith;
