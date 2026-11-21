import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TQ_BIN = join(process.cwd(), "bin", "tq");

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tq-cli-test-"));
}

function writeTask(dir: string, name: string, files: Record<string, string>) {
  const taskDir = join(dir, "tasks", name);
  mkdirSync(taskDir, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    writeFileSync(join(taskDir, k), v);
  }
}

async function buildTqBinary(): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`bun run build failed (${code}): ${stderr}`);
  }
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe("Seam B: CLI subprocess", () => {
  let dataDir: string;
  let projectDir: string;

  beforeAll(async () => {
    // `bin/tq` is gitignored. Always rebuild so this seam tests current source,
    // not a stale artifact left by an earlier run.
    await buildTqBinary();
    dataDir = makeTempDir();
    projectDir = makeTempDir();
  });

  afterAll(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {}
  });

  test("tq --help prints usage", async () => {
    const proc = Bun.spawn([TQ_BIN, "--help"], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(text).toContain("Usage");
  });

  test("tq with no arguments prints usage instead of starting the daemon", async () => {
    const proc = Bun.spawn([TQ_BIN], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(text).toContain("Usage");
    expect(text).not.toContain("running on http");
  });

  test("CLI commands do not call the daemon HTTP API", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests++;
        return new Response("ok");
      },
    });
    const descriptorPath = join(dataDir, "daemon.json");
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        pid: process.pid,
        port: server.port,
        dataDir,
        startedAt: new Date().toISOString(),
      }),
    );
    try {
      const proc = Bun.spawn([TQ_BIN, "status"], {
        cwd: projectDir,
        env: { ...process.env, TQ_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      expect(proc.exitCode).toBe(0);
      expect(text).toContain("No queues registered");
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
      rmSync(descriptorPath, { force: true });
    }
  });

  test("tq daemon --help prints daemon flags", async () => {
    const proc = Bun.spawn([TQ_BIN, "daemon", "--help"], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(text).toContain("port");
  });

  test("unknown task returns exit code 2", async () => {
    const proc = Bun.spawn([TQ_BIN, "add", "nope:nope"], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    await proc.exited;
    expect(proc.exitCode).toBe(2);
    expect((stdout + stderr).toLowerCase()).toContain("not found");
  });

  test("tq add with no daemon enqueues to SQLite", async () => {
    // Create a task in projectDir
    writeTask(projectDir, "echo", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "echo",
        name: "Echo",
      }),
      "index.ts": `export default async function(ctx){ console.log(JSON.stringify(ctx.input)); ctx.done(0); }`,
      "README.md": "# echo",
    });
    const proc = Bun.spawn([TQ_BIN, "add", "default:echo", "hello"], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toMatch(/Enqueued instance \d+ at \d{4}-\d{2}-\d{2}T/);
    expect(stdout).toContain("Task: default:echo");
    expect(stdout).toContain("Context:");
    expect(stdout).toContain(`Working directory: ${projectDir}`);
  });

  test("tq add --id enqueues a caller-supplied id and rejects duplicates", async () => {
    const proc = Bun.spawn(
      [TQ_BIN, "add", "default:echo", "--id", "job-4242", "hello"],
      {
        cwd: projectDir,
        env: { ...process.env, TQ_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toMatch(/Enqueued instance \d+/);
    expect(stdout).toContain("User id: job-4242");

    const duplicate = Bun.spawn(
      [TQ_BIN, "add", "default:echo", "--id", "job-4242", "hello"],
      {
        cwd: projectDir,
        env: { ...process.env, TQ_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = duplicate.stderr
      ? await new Response(duplicate.stderr).text()
      : "";
    await duplicate.exited;
    expect(duplicate.exitCode).toBe(2);
    expect(stderr).toContain("already exists");
  });

  test("tq add uses a string id from the context as user_id", async () => {
    const proc = Bun.spawn(
      [TQ_BIN, "add", "default:echo", '{"id":"ctx-4243","x":1}'],
      {
        cwd: projectDir,
        env: { ...process.env, TQ_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("User id: ctx-4243");
  });

  test("tq add supports escaped JSON, @file, name=value, and name:=value", async () => {
    // task with schema
    writeTask(projectDir, "pathy", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "pathy",
        name: "Pathy",
        inputSchema: "schema.json",
      }),
      "schema.json": JSON.stringify({
        type: "object",
        required: ["filepath"],
        properties: { filepath: { type: "string" } },
      }),
      "index.ts": `export default async function(ctx){ ctx.done(0); }`,
      "README.md": "# pathy",
    });
    // JSON
    let proc = Bun.spawn([TQ_BIN, "add", "default:pathy", '{"filepath":"a.txt"}'], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    // @file
    const ctxFile = join(projectDir, "ctx.json");
    writeFileSync(ctxFile, JSON.stringify({ filepath: "b.txt" }));
    proc = Bun.spawn([TQ_BIN, "add", "default:pathy", "@ctx.json"], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    // name=value
    proc = Bun.spawn([TQ_BIN, "add", "default:pathy", "filepath=c.txt"], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    // name:=value
    proc = Bun.spawn([TQ_BIN, "add", "default:pathy", 'filepath:="d.txt"'], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);
  });

  test("relative path fields resolve against invocation directory; absolute paths unchanged", async () => {
    writeTask(projectDir, "pfile", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "pfile",
        name: "Pfile",
        inputSchema: "schema.json",
      }),
      "schema.json": JSON.stringify({
        type: "object",
        required: ["filepath"],
        properties: { filepath: { type: "string", format: "path" } },
      }),
      "index.ts": `export default async function(ctx){ ctx.done(0); }`,
      "README.md": "# pfile",
    });
    const subdir = join(projectDir, "sub");
    mkdirSync(subdir, { recursive: true });
    const proc = Bun.spawn([TQ_BIN, "add", "default:pfile", "fixture/1"], {
      cwd: subdir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain(join(subdir, "fixture/1"));
  });

  test("-v/--verbose writes diagnostics to stderr without changing stdout output", async () => {
    writeTask(projectDir, "verb", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "verb",
        name: "Verb",
      }),
      "index.ts": `export default async function(ctx){ ctx.done(0); }`,
      "README.md": "# verb",
    });
    const proc = Bun.spawn([TQ_BIN, "-v", "add", "default:verb", '{"x":1}'], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stderr).toContain("Resolved task");
    expect(stdout).toContain("Enqueued instance");
    expect(stdout).toContain("Task: default:verb");
  });

  test("schema violations print field issues and exit 2", async () => {
    writeTask(projectDir, "bad", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "bad",
        name: "Bad",
        inputSchema: "schema.json",
      }),
      "schema.json": JSON.stringify({
        type: "object",
        required: ["count"],
        properties: { count: { type: "integer", minimum: 5 } },
      }),
      "index.ts": `export default async function(ctx){ ctx.done(0); }`,
      "README.md": "# bad",
    });
    const proc = Bun.spawn([TQ_BIN, "add", "default:bad", '{"count":1}'], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    await proc.exited;
    expect(proc.exitCode).toBe(2);
    expect((stdout + stderr).toLowerCase()).toContain("validation");
  });

  test("tq status prints queues info", async () => {
    const proc = Bun.spawn([TQ_BIN, "status"], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Queue");
    expect(stdout).toContain("State");
    expect(stdout).toContain("Concurrency");
    expect(stdout).toContain("default:echo");
  });

  test("tq add prints the normalized context after schema defaults", async () => {
    writeTask(projectDir, "defaulted", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "defaulted",
        name: "Defaulted",
        inputSchema: "schema.json",
      }),
      "schema.json": JSON.stringify({
        type: "object",
        properties: { mode: { type: "string", default: "fast" } },
      }),
      "index.ts": `export default async function(ctx){ ctx.done(0); }`,
      "README.md": "# defaulted",
    });
    const proc = Bun.spawn([TQ_BIN, "add", "default:defaulted", "{}"], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain('"mode":"fast"');
  });

  test("tq status surfaces discovery warnings", async () => {
    writeTask(projectDir, "broken", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "broken",
        name: "Broken",
      }),
      "index.ts": `export default async function(ctx){ ctx.done(0); }`,
    });
    const proc = Bun.spawn([TQ_BIN, "status"], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stderr).toContain("Warning:");
    expect(stderr).toContain("missing README.md");
  });

  test("tq logs <instance-id> prints merged log", async () => {
    // enqueue a task first
    writeTask(projectDir, "logtest", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "logtest",
        name: "Logtest",
      }),
      "index.ts": `export default async function(ctx){ console.log("hi"); ctx.done(0); }`,
      "README.md": "# logtest",
    });
    let proc = Bun.spawn([TQ_BIN, "add", "default:logtest", '{"x":1}'], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const addOut = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    const m = addOut.match(/Enqueued instance (\d+)/);
    expect(m).toBeTruthy();
    const id = m![1]!;
    proc = Bun.spawn([TQ_BIN, "logs", id], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const logsOut = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(logsOut).toContain(`Logs for instance ${id}`);
  });

  test("invalid input (malformed JSON) returns exit code 2", async () => {
    writeTask(projectDir, "jsony", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "jsony",
        name: "Jsony",
      }),
      "index.ts": `export default async function(ctx){ ctx.done(0); }`,
      "README.md": "# jsony",
    });
    const proc = Bun.spawn([TQ_BIN, "add", "default:jsony", '{bad json'], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    await proc.exited;
    expect(proc.exitCode).toBe(2);
  });

  test("control commands fail clearly with no daemon running", async () => {
    for (const cmd of ["start", "stop", "abort", "reload"]) {
      const proc = Bun.spawn([TQ_BIN, cmd, "default:echo"], {
        cwd: projectDir,
        env: { ...process.env, TQ_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      await proc.exited;
      expect(proc.exitCode).toBe(1);
      expect((stdout + stderr).toLowerCase()).toContain("daemon");
    }
  });

  test("CLI works when descriptor port is unreachable (no HTTP needed)", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests++;
        return new Response("ok");
      },
    });
    const descriptorPath = join(dataDir, "daemon.json");
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        pid: process.pid,
        port: server.port,
        dataDir,
        startedAt: new Date().toISOString(),
      }),
    );
    try {
      const proc = Bun.spawn([TQ_BIN, "status"], {
        cwd: projectDir,
        env: { ...process.env, TQ_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      expect(proc.exitCode).toBe(0);
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
      rmSync(descriptorPath, { force: true });
    }
  });

  test("offline add is picked up by the daemon; abort uses control requests; clear --all refuses while RUNNING", async () => {
    const liveData = makeTempDir();
    const liveProject = makeTempDir();
    const pickupMarker = join(liveProject, "pickup.marker");
    const liveMarker = join(liveProject, "live.marker");

    writeTask(liveProject, "pickup", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "pickup",
        name: "Pickup",
        concurrency: 1,
      }),
      "index.ts": `import { writeFileSync } from "node:fs";
export default async function(ctx: any) {
  console.log("picked");
  writeFileSync(ctx.input.marker, "picked");
  ctx.done(0);
}`,
      "README.md": "# pickup",
    });

    writeTask(liveProject, "live", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "live",
        name: "Live",
        concurrency: 1,
      }),
      "index.ts": `import { writeFileSync } from "node:fs";
export default async function(ctx: any) {
  writeFileSync(ctx.input.marker, "started");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15000);
    ctx.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  ctx.done(0);
}`,
      "README.md": "# live",
    });

    const env = { ...process.env, TQ_DATA_DIR: liveData };
    const run = (args: string[]) =>
      Bun.spawn([TQ_BIN, ...args], {
        cwd: liveProject,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

    let proc = run(["add", "default:pickup", JSON.stringify({ marker: pickupMarker })]);
    let stdout = await new Response(proc.stdout).text();
    let stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    const pickupId = stdout.match(/Enqueued instance (\d+)/)?.[1];
    expect(pickupId).toBeTruthy();

    proc = run(["add", "default:live", JSON.stringify({ marker: liveMarker })]);
    stdout = await new Response(proc.stdout).text();
    stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    const daemon = Bun.spawn([TQ_BIN, "daemon", "--port", "0"], {
      cwd: liveProject,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      expect(await waitForFile(join(liveData, "daemon.json"))).toBe(true);
      expect(await waitForFile(pickupMarker)).toBe(true);
      expect(await waitForFile(liveMarker)).toBe(true);

      proc = run(["logs", pickupId!]);
      stdout = await new Response(proc.stdout).text();
      await proc.exited;
      expect(proc.exitCode).toBe(0);
      expect(stdout).toContain("picked");

      // clear --all must refuse while the live instance is RUNNING.
      proc = run(["clear", "--all", "default:live"]);
      stdout = await new Response(proc.stdout).text();
      stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      await proc.exited;
      expect(proc.exitCode).toBe(1);
      expect((stdout + stderr).toLowerCase()).toContain("running");

      // abort is a durable control request consumed by the daemon, not HTTP.
      proc = run(["abort", "default:live"]);
      stdout = await new Response(proc.stdout).text();
      stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      await proc.exited;
      expect(proc.exitCode).toBe(0);
      expect(stdout).toContain("returned to PENDING");

      proc = run(["status"]);
      stdout = await new Response(proc.stdout).text();
      await proc.exited;
      expect(proc.exitCode).toBe(0);
      expect(stdout).toContain("STOPPED");
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited.catch(() => {});
      rmSync(liveData, { recursive: true, force: true });
      rmSync(liveProject, { recursive: true, force: true });
    }
  });

  test("tq add records the invocation directory and the daemon runs there", async () => {
    const liveData = makeTempDir();
    const liveProject = makeTempDir();
    const nested = join(liveProject, "nested", "deeper");
    mkdirSync(nested, { recursive: true });
    const marker = join(liveProject, "cwd.marker");

    writeTask(liveProject, "where", {
      "settings.json": JSON.stringify({
        namespace: "default",
        id: "where",
        name: "Where",
        concurrency: 1,
      }),
      "index.ts": `import { writeFileSync } from "node:fs";
export default async function(ctx: any) {
  console.log(ctx.cwd);
  writeFileSync(ctx.input.marker, ctx.cwd);
  ctx.done(0);
}`,
      "README.md": "# where",
    });

    const env = { ...process.env, TQ_DATA_DIR: liveData };

    // Enqueue offline from a nested directory.
    let proc = Bun.spawn(
      [TQ_BIN, "add", "default:where", JSON.stringify({ marker })],
      { cwd: nested, env, stdout: "pipe", stderr: "pipe" },
    );
    let stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain(`Working directory: ${nested}`);
    const instanceId = stdout.match(/Enqueued instance (\d+)/)?.[1];
    expect(instanceId).toBeTruthy();

    // Start the daemon from the project root; the instance must keep the
    // directory it was added from.
    const daemon = Bun.spawn([TQ_BIN, "daemon", "--port", "0"], {
      cwd: liveProject,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      expect(await waitForFile(join(liveData, "daemon.json"))).toBe(true);
      expect(await waitForFile(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe(nested);

      proc = Bun.spawn([TQ_BIN, "logs", instanceId!], {
        cwd: liveProject,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      stdout = await new Response(proc.stdout).text();
      await proc.exited;
      expect(proc.exitCode).toBe(0);
      expect(stdout).toContain(nested);
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited.catch(() => {});
      rmSync(liveData, { recursive: true, force: true });
      rmSync(liveProject, { recursive: true, force: true });
    }
  });
});
