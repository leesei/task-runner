import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapDataDir,
  closeDatabase,
  configureDatabase,
  openDatabase,
  resolveDataDir,
  type DB,
} from "../src/db/database.ts";
import { readLogFile } from "../src/db/logs.ts";
import { getInstance, insertInstance } from "../src/db/queries.ts";
import { installConsoleInterception } from "../src/runner/execution.ts";
import { autostartQueuesOnBoot, ensureQueuesForTasks } from "../src/runner/queue-state.ts";
import { createRunner } from "../src/runner/runner.ts";
import { loadAllTasks } from "../src/tasks/discovery.ts";

const projectDir = process.cwd();

let dataDir: string;
let db: DB;
let runner: ReturnType<typeof createRunner>;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function enqueue(taskId: string, input: unknown): number {
  return insertInstance(db, taskId, JSON.stringify(input), null);
}

async function runToCompletion(ids: number[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await runner.runOnce(db);
    const states = ids.map((id) => getInstance(db, id)?.state);
    if (states.every((state) => state === "SUCCESS" || state === "FAILED")) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for instances ${ids.join(", ")}`);
}

function logText(instanceId: number): string {
  const instance = getInstance(db, instanceId);
  if (!instance?.log_path) return "";
  return readLogFile(instance.log_path)
    .map((record) => record.text)
    .join("\n");
}

beforeAll(() => {
  dataDir = makeTempDir("tq-sample-runner-");
  const config = resolveDataDir(dataDir);
  bootstrapDataDir(config);
  db = openDatabase(config.dbPath);
  configureDatabase(db);

  loadAllTasks(db, projectDir, []);
  ensureQueuesForTasks(db);
  autostartQueuesOnBoot(db);
  installConsoleInterception();

  runner = createRunner({ dataDir, pollIntervalMs: 5 });
});

afterAll(() => {
  if (db) closeDatabase(db);
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sample tasks through the runner contract", () => {
  test("all five tasks execute through createRunner", async () => {
    const listDir = makeTempDir("tq-sample-ls-");
    writeFileSync(join(listDir, "listed.txt"), "");

    process.env.TQ_SAMPLE_VISIBLE = "visible-value";

    const ids = {
      ls: enqueue("default:ls", { filepath: listDir }),
      cat: enqueue("default:cat", {
        filepath: join(projectDir, "tests/cat/sensitive-input.txt"),
      }),
      sha256: enqueue("default:sha256", {
        filepath: join(projectDir, "tests/sha256/hello.txt"),
      }),
      env: enqueue("default:env", { filter: "TQ_SAMPLE_", values: true }),
      minfo: Bun.which("mediainfo")
        ? enqueue("default:minfo", { filepath: join(projectDir, "tests/1/1.mp4") })
        : null,
    };

    try {
      const checkedIds = Object.values(ids).filter((id): id is number => id !== null);
      await runToCompletion(checkedIds);

      expect(getInstance(db, ids.ls)?.state).toBe("SUCCESS");
      expect(getInstance(db, ids.cat)?.state).toBe("SUCCESS");
      expect(getInstance(db, ids.sha256)?.state).toBe("SUCCESS");
      expect(getInstance(db, ids.env)?.state).toBe("SUCCESS");
      if (ids.minfo !== null) {
        expect(getInstance(db, ids.minfo)?.state).toBe("SUCCESS");
      }

      expect(logText(ids.ls)).toContain("listed.txt");

      const catLog = logText(ids.cat);
      expect(catLog).toContain("password=[REDACTED]");
      expect(catLog).not.toContain("supersecret123");

      expect(logText(ids.sha256)).toContain(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
      expect(logText(ids.env)).toContain("TQ_SAMPLE_VISIBLE=visible-value");
    } finally {
      delete process.env.TQ_SAMPLE_VISIBLE;
    }
  });
});
