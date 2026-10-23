import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TQ_BIN = join(process.cwd(), "bin", "tq");

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tq-cli-test-"));
}

describe("Seam B: CLI subprocess", () => {
  let dataDir: string;
  let projectDir: string;

  beforeAll(() => {
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
    expect(stdout + stderr).toContain("not found");
  });

  test("control commands fail without daemon", async () => {
    const proc = Bun.spawn([TQ_BIN, "start", "some:queue"], {
      cwd: projectDir,
      env: { ...process.env, TQ_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });
});
