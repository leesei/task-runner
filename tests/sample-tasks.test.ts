import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import catTask from "../tasks/cat/index.ts";
import envTask from "../tasks/env/index.ts";
import lsTask from "../tasks/ls/index.ts";
import minfoTask from "../tasks/minfo/index.ts";
import sha256Task from "../tasks/sha256/index.ts";

type TaskFn = (ctx: {
  input: unknown;
  signal: AbortSignal;
  done: (exitCode: number) => void;
}) => Promise<void>;

const TASKS: Record<string, TaskFn> = {
  ls: lsTask as TaskFn,
  cat: catTask as TaskFn,
  env: envTask as TaskFn,
  sha256: sha256Task as TaskFn,
  minfo: minfoTask as TaskFn,
};

const FILE_TASKS = ["ls", "cat", "sha256", "minfo"];

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runTask(task: TaskFn, input: unknown) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  let exitCode: number | undefined;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };

  try {
    await task({
      input,
      signal: new AbortController().signal,
      done: (code: number) => {
        exitCode = code;
      },
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return { exitCode: exitCode ?? 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sample task definitions", () => {
  for (const name of Object.keys(TASKS)) {
    test(`${name} has the task folder contract`, () => {
      const dir = join(process.cwd(), "tasks", name);
      for (const file of ["index.ts", "README.md", "settings.json", "schema.json"]) {
        expect(existsSync(join(dir, file))).toBe(true);
      }

      const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
      expect(settings.namespace).toBe("default");
      expect(settings.id).toBe(name);
      expect(typeof settings.name).toBe("string");
      expect(settings.name.length).toBeGreaterThan(0);
      expect(typeof settings.description).toBe("string");
      expect(settings.description.length).toBeGreaterThan(0);
      expect(settings.concurrency).toBeGreaterThan(0);
      expect(typeof settings.category).toBe("string");
      expect(settings.category.length).toBeGreaterThan(0);
      expect(settings.timeoutMs).toBeGreaterThan(0);
      expect(typeof TASKS[name]).toBe("function");
    });
  }

  for (const name of FILE_TASKS) {
    test(`${name} schema marks its filepath as a path`, () => {
      const schema = JSON.parse(
        readFileSync(join(process.cwd(), "tasks", name, "schema.json"), "utf-8"),
      );
      expect(schema.type).toBe("object");
      expect(schema.properties.filepath.type).toBe("string");
      expect(schema.properties.filepath.format).toBe("path");
      expect(schema.required).toContain("filepath");
    });
  }

  test("env schema takes an optional filter and values flag", () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), "tasks", "env", "schema.json"), "utf-8"),
    );
    expect(schema.type).toBe("object");
    expect(schema.properties.filter.type).toBe("string");
    expect(schema.properties.values.type).toBe("boolean");
  });
});

describe("ls", () => {
  test("lists a directory and fails clearly for a missing one", async () => {
    const dir = makeTempDir("tq-ls-");
    writeFileSync(join(dir, "hello.txt"), "");

    const ok = await runTask(TASKS.ls!, { filepath: dir });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("hello.txt");

    const missing = await runTask(TASKS.ls!, { filepath: join(dir, "does-not-exist") });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toLowerCase()).toContain("no such file");
  });
});

describe("cat", () => {
  test("redacts labeled and token-shaped secrets", async () => {
    const result = await runTask(TASKS.cat!, {
      filepath: join(process.cwd(), "tests/cat/sensitive-input.txt"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("password=[REDACTED]");
    expect(result.stdout).toContain("api_key=[REDACTED]");
    expect(result.stdout).toContain("GH_TOKEN=[REDACTED]");
    expect(result.stdout).toContain("normal line");
    expect(result.stdout).not.toContain("supersecret123");
    expect(result.stdout).not.toContain("AKIA12345678901234567890");
    expect(result.stdout).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(result.stdout).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(result.stderr).toContain("redacted");
  });

  test("prints non-sensitive files unchanged and honours limit", async () => {
    const filepath = join(process.cwd(), "tests/cat/normal-input.txt");
    const all = await runTask(TASKS.cat!, { filepath });
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain("This is a normal text file.");

    const limited = await runTask(TASKS.cat!, { filepath, limit: 2 });
    expect(limited.exitCode).toBe(0);
    expect(limited.stdout.split("\n")).toHaveLength(2);
  });
});

describe("env", () => {
  test("redacts sensitive names and supports filter and names-only", async () => {
    process.env.TQ_TEST_API_KEY = "supersecret123";
    process.env.TQ_TEST_NORMAL = "visible";
    try {
      const values = await runTask(TASKS.env!, { filter: "TQ_TEST_", values: true });
      expect(values.exitCode).toBe(0);
      expect(values.stdout).toContain("TQ_TEST_API_KEY=[REDACTED]");
      expect(values.stdout).toContain("TQ_TEST_NORMAL=visible");
      expect(values.stdout).not.toContain("supersecret123");

      const names = await runTask(TASKS.env!, { filter: "TQ_TEST_", values: false });
      expect(names.exitCode).toBe(0);
      expect(names.stdout).toContain("TQ_TEST_API_KEY");
      expect(names.stdout).toContain("TQ_TEST_NORMAL");
      expect(names.stdout).not.toContain("supersecret123");
    } finally {
      delete process.env.TQ_TEST_API_KEY;
      delete process.env.TQ_TEST_NORMAL;
    }
  });
});

describe("sha256", () => {
  test("prints the known digest of hello.txt", async () => {
    const result = await runTask(TASKS.sha256!, {
      filepath: join(process.cwd(), "tests/sha256/hello.txt"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("fails clearly for a missing file", async () => {
    const result = await runTask(TASKS.sha256!, {
      filepath: join(makeTempDir("tq-sha-"), "missing.txt"),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("sha256:");
  });
});

describe("minfo", () => {
  test("reports a missing mediainfo CLI clearly", () => {
    const filepath = join(process.cwd(), "tests/1/1.mp4");
    const script = `
      import run from ${JSON.stringify(join(process.cwd(), "tasks/minfo/index.ts"))};
      let exitCode;
      await run({
        input: { filepath: ${JSON.stringify(filepath)} },
        signal: new AbortController().signal,
        done: (code) => { exitCode = code; },
      });
      process.exit(exitCode ?? 0);
    `;

    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      env: { ...process.env, PATH: "/nonexistent" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("mediainfo");
    expect(stderr).toContain("not found");
  });

  test.skipIf(!Bun.which("mediainfo"))("exits 0 for a readable media file", async () => {
    const result = await runTask(TASKS.minfo!, {
      filepath: join(process.cwd(), "tests/1/1.mp4"),
    });
    expect(result.exitCode).toBe(0);
  });
});
