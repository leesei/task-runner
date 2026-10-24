import { runWith as lsRunWith } from "../tasks/ls/index.ts";
import { runWith as minfoRunWith } from "../tasks/minfo/index.ts";
import { runWith as catRunWith } from "../tasks/cat/index.ts";
import { runWith as envRunWith } from "../tasks/env/index.ts";
import { runWith as shaRunWith } from "../tasks/sha256/index.ts";

interface RunOpts {
  input: Record<string, unknown>;
  signal: AbortSignal;
  done: (exitCode: number) => void;
}

interface Result {
  name: string;
  exit: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

const RESULTS: Result[] = [];

async function run(
  name: string,
  fn: (ctx: RunOpts) => Promise<void>,
  opts: { expectFailure?: boolean } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;

  let exit = 999;
  const signal = new AbortController().signal;

  console.log = (...a: unknown[]) => stdout.push(String(a.join(" ")));
  console.error = (...a: unknown[]) => stderr.push(String(a.join(" ")));
  try {
    await fn({ input: {}, signal, done: (c) => { exit = c; } });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  const ok = opts.expectFailure ? exit !== 0 : exit === 0;
  RESULTS.push({ name, exit, stdout: stdout.join("\n"), stderr: stderr.join("\n"), ok });
}

async function main() {
  console.log("=== Task Runner Test Suite ===\n");

  // ls
  await run("ls(tests/1)", (ctx) =>
    lsRunWith({ ...ctx, input: { filepath: "tests/1" } }),
  );
  await run("ls(missing dir)", (ctx) =>
    lsRunWith({ ...ctx, input: { filepath: "/tmp/does-not-exist-xyz" } }),
  { expectFailure: true });

  // cat
  await run("cat(normal file)", (ctx) =>
    catRunWith({ ...ctx, input: { filepath: "tests/cat/normal-input.txt" } }),
  );
  await run("cat(sensitive file)", (ctx) =>
    catRunWith({ ...ctx, input: { filepath: "tests/cat/sensitive-input.txt" } }),
  );
  await run("cat(missing file)", (ctx) =>
    catRunWith({ ...ctx, input: { filepath: "/tmp/does-not-exist-xyz" } }),
  { expectFailure: true });
  await run("cat(limit 2)", (ctx) =>
    catRunWith({ ...ctx, input: { filepath: "tests/cat/normal-input.txt", limit: 2 } }),
  );

  // sha256
  await run("sha256(hello.txt)", (ctx) =>
    shaRunWith({ ...ctx, input: { filepath: "tests/sha256/hello.txt" } }),
  );
  await run("sha256(missing file)", (ctx) =>
    shaRunWith({ ...ctx, input: { filepath: "/tmp/does-not-exist-xyz" } }),
  { expectFailure: true });

  // env
  await run("env(values true)", (ctx) =>
    envRunWith({ ...ctx, input: { values: true } }),
  );
  await run("env(filter PATH, values true)", (ctx) =>
    envRunWith({ ...ctx, input: { filter: "PATH", values: true } }),
  );
  await run("env(filter HOME, names only)", (ctx) =>
    envRunWith({ ...ctx, input: { filter: "HOME", values: false } }),
  );
  await run("env(no args)", (ctx) =>
    envRunWith({ ...ctx, input: {} }),
  );

  // minfo (skipped if mediainfo is not available)
  if (Bun.which("mediainfo")) {
    await run("minfo(tests/1/1.mp4)", (ctx) =>
      minfoRunWith({ ...ctx, input: { filepath: "tests/1/1.mp4" } }),
    );
  } else {
    console.log("minfo: skipped (mediainfo not available)");
  }

  // Summary
  console.log("\n=== Summary ===");
  for (const r of RESULTS) {
    const status = r.ok ? "OK" : `FAILED (exit ${r.exit})`;
    console.log(`${status}  ${r.name}`);
    if (!r.ok && r.stdout) {
      console.log(`  stdout:\n${r.stdout.split("\n").map(l => "    " + l).join("\n")}`);
    }
    if (!r.ok && r.stderr) {
      console.log(`  stderr:\n${r.stderr.split("\n").map(l => "    " + l).join("\n")}`);
    }
  }

  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n${RESULTS.length} tests run, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log("Failed tests:");
    for (const r of failed) console.log(`  - ${r.name} (exit ${r.exit})`);
    process.exit(1);
  }
}

main();
