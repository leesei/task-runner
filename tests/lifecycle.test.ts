import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { getInstance, getQueue, insertControlRequest, insertTask } from "../src/db/queries.ts";
import { Database } from "bun:sqlite";
import { createLifecycle, type Lifecycle } from "../src/core/lifecycle.ts";
import { CoreError } from "../src/core/errors.ts";
import type { LifecycleEvent } from "../src/core/events.ts";

interface RecordingSink {
  events: LifecycleEvent[];
  publish(event: LifecycleEvent): void;
}

function recordingSink(): RecordingSink {
  const events: LifecycleEvent[] = [];
  return {
    events,
    publish(event) {
      events.push(event);
    },
  };
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function addTask(
  db: DB,
  id: string,
  options: { concurrency?: number; timeoutMs?: number } = {},
): void {
  insertTask(db, {
    id,
    namespace: "default",
    name: id,
    description: "",
    category: null,
    concurrency: options.concurrency ?? 1,
    timeout_ms: options.timeoutMs ?? 30_000,
    input_schema: null,
    manifest_hash: null,
    manifest_warnings: null,
    entry_point: `/tmp/${id.replace(":", "-")}.ts`,
  });
}

describe("lifecycle: enqueue, claim, finish", () => {
  let dataDir: string;
  let db: DB;
  let lifecycle: Lifecycle;
  let sink: RecordingSink;

  beforeEach(() => {
    dataDir = makeTempDir("tq-lifecycle-");
    const config = resolveDataDir(dataDir);
    bootstrapDataDir(config);
    db = openDatabase(config.dbPath);
    configureDatabase(db);
    sink = recordingSink();
    lifecycle = createLifecycle({ db, events: sink, logDir: config.logDir });
    addTask(db, "default:echo", { concurrency: 2 });
    lifecycle.syncQueues();
    sink.events.length = 0;
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enqueue inserts PENDING work and starts an IDLE queue", () => {
    const { id, createdAt } = lifecycle.enqueue("default:echo", { seq: 1 });

    const instance = getInstance(db, id)!;
    expect(instance.state).toBe("PENDING");
    expect(instance.attempt).toBe(1);
    expect(JSON.parse(instance.input)).toEqual({ seq: 1 });
    expect(createdAt).toBe(instance.created_at);
    expect(getQueue(db, "default:echo")!.state).toBe("PROCESSING");

    expect(sink.events).toEqual([
      { type: "instanceStateChanged", instanceId: id, state: "PENDING" },
      { type: "queueStateChanged", queueId: "default:echo", state: "PROCESSING" },
    ]);
  });

  test("claim is FIFO, respects concurrency, and does not increment the attempt", () => {
    const first = lifecycle.enqueue("default:echo", { seq: 1 });
    const second = lifecycle.enqueue("default:echo", { seq: 2 });
    const third = lifecycle.enqueue("default:echo", { seq: 3 });

    const claims = lifecycle.claim();
    expect(claims.map((claim) => claim.instanceId)).toEqual([first.id, second.id]);
    expect(claims.map((claim) => claim.attempt)).toEqual([1, 1]);

    for (const claim of claims) {
      const instance = getInstance(db, claim.instanceId)!;
      expect(instance.state).toBe("RUNNING");
      expect(instance.attempt).toBe(1);
      expect(instance.started_at).not.toBeNull();
      expect(instance.log_path).toBe(claim.logPath);
      expect(instance.log_path).toContain(`instance-${claim.instanceId}.jsonl`);
    }

    expect(lifecycle.claim()).toEqual([]);
    expect(getInstance(db, third.id)!.state).toBe("PENDING");

    sink.events.length = 0;
    lifecycle.finishRun(
      { instanceId: claims[0]!.instanceId, attempt: claims[0]!.attempt },
      { kind: "success" },
    );
    const next = lifecycle.claim();
    expect(next.map((claim) => claim.instanceId)).toEqual([third.id]);
  });

  test("finish applies only to the claimed attempt and drains the queue", () => {
    const { id } = lifecycle.enqueue("default:echo", {});
    const [claim] = lifecycle.claim();

    sink.events.length = 0;
    const result = lifecycle.finishRun(
      { instanceId: claim!.instanceId, attempt: claim!.attempt },
      { kind: "success" },
    );

    expect(result.applied).toBe(true);
    expect(getInstance(db, id)!.state).toBe("SUCCESS");
    expect(getInstance(db, id)!.exit_code).toBe(0);
    expect(getQueue(db, "default:echo")!.state).toBe("IDLE");
    expect(sink.events).toEqual([
      { type: "instanceStateChanged", instanceId: id, state: "SUCCESS" },
      { type: "queueStateChanged", queueId: "default:echo", state: "IDLE" },
    ]);
  });

  test("a stale completion cannot overwrite a newer attempt", () => {
    const { id } = lifecycle.enqueue("default:echo", {});
    const [first] = lifecycle.claim();
    expect(first!.attempt).toBe(1);

    const abort = lifecycle.abortQueue("default:echo");
    expect(abort.cancelled).toEqual([{ instanceId: id, attempt: 1 }]);
    expect(abort.queueState).toBe("STOPPED");
    expect(getInstance(db, id)!.attempt).toBe(2);
    expect(getInstance(db, id)!.state).toBe("PENDING");

    lifecycle.start("default:echo");
    const [second] = lifecycle.claim();
    expect(second!.attempt).toBe(2);

    const stale = lifecycle.finishRun(
      { instanceId: id, attempt: first!.attempt },
      { kind: "success" },
    );
    expect(stale).toEqual({ applied: false, ignored: "stale-attempt" });
    expect(getInstance(db, id)!.state).toBe("RUNNING");

    const current = lifecycle.finishRun(
      { instanceId: id, attempt: second!.attempt },
      { kind: "failure", exitCode: 3, reason: "nope" },
    );
    expect(current.applied).toBe(true);
    expect(getInstance(db, id)!.state).toBe("FAILED");
    expect(getInstance(db, id)!.exit_code).toBe(3);
    expect(getInstance(db, id)!.failure_reason).toBe("nope");
  });

  test("abort discards a control request whose tokens are stale", () => {
    const { id } = lifecycle.enqueue("default:echo", {});
    const [claim] = lifecycle.claim();

    sink.events.length = 0;
    const stale = lifecycle.abortQueue("default:echo", [
      { instanceId: id, attempt: claim!.attempt + 1 },
    ]);
    expect(stale).toEqual({
      cancelled: [],
      queueState: "PROCESSING",
      discarded: true,
    });
    expect(getInstance(db, id)!.state).toBe("RUNNING");
    expect(getInstance(db, id)!.attempt).toBe(1);
    expect(sink.events).toEqual([]);

    const applied = lifecycle.abortQueue("default:echo", [
      { instanceId: id, attempt: claim!.attempt },
    ]);
    expect(applied.discarded).toBeUndefined();
    expect(applied.cancelled).toEqual([{ instanceId: id, attempt: 1 }]);
    expect(getQueue(db, "default:echo")!.state).toBe("STOPPED");
    expect(getInstance(db, id)!.attempt).toBe(2);
  });

  test("abort increments every running attempt and leaves exactly one retry", () => {
    const first = lifecycle.enqueue("default:echo", {});
    const second = lifecycle.enqueue("default:echo", {});
    lifecycle.claim();

    lifecycle.abortQueue("default:echo");
    expect(getInstance(db, first.id)!.attempt).toBe(2);
    expect(getInstance(db, second.id)!.attempt).toBe(2);
    expect(lifecycle.claim()).toEqual([]);

    lifecycle.start("default:echo");
    expect(lifecycle.claim().map((claim) => claim.instanceId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(lifecycle.claim()).toEqual([]);
  });

  test("start and stop are idempotent and stop allows IDLE -> STOPPED", () => {
    lifecycle.stop("default:echo");
    expect(getQueue(db, "default:echo")!.state).toBe("STOPPED");
    sink.events.length = 0;
    expect(lifecycle.stop("default:echo")).toBe("STOPPED");
    expect(sink.events).toEqual([]);

    expect(lifecycle.start("default:echo")).toBe("IDLE");
    expect(lifecycle.start("default:echo")).toBe("IDLE");

    lifecycle.enqueue("default:echo", {});
    expect(lifecycle.start("default:echo")).toBe("PROCESSING");
    expect(lifecycle.start("default:echo")).toBe("PROCESSING");

    expect(lifecycle.stop("default:echo")).toBe("STOPPED");
    expect(lifecycle.stop("default:echo")).toBe("STOPPED");
  });

  test("syncQueues creates queues, updates concurrency, and never retires", () => {
    addTask(db, "default:new", { concurrency: 3 });
    const first = lifecycle.syncQueues();
    expect(first.created).toBe(1);
    expect(getQueue(db, "default:new")!.concurrency).toBe(3);

    const queue = getQueue(db, "default:echo")!;
    expect(queue.concurrency).toBe(2);
    db.run("UPDATE tasks SET concurrency = 5 WHERE id = 'default:echo'");

    const second = lifecycle.syncQueues();
    expect(second).toEqual({ created: 0, updated: 1 });
    expect(getQueue(db, "default:echo")!.concurrency).toBe(5);

    // A queue with no task row is left alone.
    db.run("DELETE FROM tasks WHERE id = 'default:new'");
    lifecycle.syncQueues();
    expect(getQueue(db, "default:new")).not.toBeNull();

    db.run("UPDATE tasks SET concurrency = 0 WHERE id = 'default:echo'");
    try {
      lifecycle.syncQueues();
    } catch (err) {
      expect((err as CoreError).code).toBe("INVALID_CONCURRENCY");
    }
  });

  test("recoverOnBoot resets RUNNING work, increments attempts, and keeps STOPPED queues", () => {
    const { id } = lifecycle.enqueue("default:echo", {});
    lifecycle.claim();

    addTask(db, "default:stopped");
    lifecycle.syncQueues();
    lifecycle.enqueue("default:stopped", {});
    lifecycle.stop("default:stopped");

    // Leave the other queue IDLE so recovery has a transition to publish.
    db.run("UPDATE queues SET state = 'IDLE' WHERE id = 'default:echo'");

    sink.events.length = 0;
    const result = lifecycle.recoverOnBoot();
    expect(result).toEqual({ reset: 1, started: 1, stayedStopped: 1 });
    expect(getInstance(db, id)!.state).toBe("PENDING");
    expect(getInstance(db, id)!.attempt).toBe(2);
    expect(getQueue(db, "default:echo")!.state).toBe("PROCESSING");
    expect(getQueue(db, "default:stopped")!.state).toBe("STOPPED");

    // Instance event precedes the queue event.
    expect(sink.events).toEqual([
      { type: "instanceStateChanged", instanceId: id, state: "PENDING" },
      { type: "queueStateChanged", queueId: "default:echo", state: "PROCESSING" },
    ]);
  });

  test("clearQueue deletes eligible rows, returns log paths, and touches no files", () => {
    const logDir = resolveDataDir(dataDir).logDir;
    const success = lifecycle.enqueue("default:echo", {});
    const [claim] = lifecycle.claim();
    lifecycle.finishRun(
      { instanceId: claim!.instanceId, attempt: claim!.attempt },
      { kind: "success" },
    );

    const failed = lifecycle.enqueue("default:echo", {});
    const [second] = lifecycle.claim();
    lifecycle.finishRun(
      { instanceId: second!.instanceId, attempt: second!.attempt },
      { kind: "failure", exitCode: 1 },
    );

    const successPath = getInstance(db, success.id)!.log_path!;
    const failedPath = getInstance(db, failed.id)!.log_path!;
    writeFileSync(successPath, "kept\n");
    writeFileSync(failedPath, "kept\n");

    const clearedSuccess = lifecycle.clearQueue("default:echo");
    expect(clearedSuccess.deleted).toBe(1);
    expect(clearedSuccess.logPaths).toEqual([successPath]);
    expect(getInstance(db, success.id)).toBeNull();
    expect(getInstance(db, failed.id)).not.toBeNull();
    expect(require("node:fs").existsSync(successPath)).toBe(true);

    const clearedAll = lifecycle.clearQueue("default:echo", { all: true });
    expect(clearedAll.deleted).toBe(1);
    expect(clearedAll.logPaths).toEqual([failedPath]);
    expect(require("node:fs").existsSync(failedPath)).toBe(true);
    expect(logDir).toBeTruthy();
  });

  test("clear --all refuses while an instance is RUNNING", () => {
    lifecycle.enqueue("default:echo", {});
    lifecycle.claim();

    let caught: unknown;
    try {
      lifecycle.clearQueue("default:echo", { all: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CoreError);
    expect((caught as CoreError).code).toBe("CLEAR_REFUSED_RUNNING");
    expect((caught as CoreError).runningIds).toHaveLength(1);
  });

  test("a throwing event sink cannot fail a transition", () => {
    const throwing = createLifecycle({
      db,
      logDir: resolveDataDir(dataDir).logDir,
      events: {
        publish() {
          throw new Error("subscriber boom");
        },
      },
    });

    expect(() => throwing.enqueue("default:echo", {})).not.toThrow();
    expect(getQueue(db, "default:echo")!.state).toBe("PROCESSING");
  });

  test("claimQueue is per-queue", () => {
    addTask(db, "default:other");
    lifecycle.syncQueues();
    const mine = lifecycle.enqueue("default:echo", {});
    const other = lifecycle.enqueue("default:other", {});

    const claims = lifecycle.claimQueue("default:echo");
    expect(claims.map((claim) => claim.instanceId)).toEqual([mine.id]);
    expect(getInstance(db, other.id)!.state).toBe("PENDING");

    expect(lifecycle.claimQueue("default:other")).toHaveLength(1);
    expect(lifecycle.claimQueue("default:other")).toEqual([]);
  });

  test("claim publishes instance events before queue events across queues", () => {
    addTask(db, "default:a");
    addTask(db, "default:b");
    lifecycle.syncQueues();
    const first = lifecycle.enqueue("default:a", {});
    const second = lifecycle.enqueue("default:b", {});
    // Leave a third queue PROCESSING with no work: claim repairs it to IDLE.
    addTask(db, "default:empty");
    lifecycle.syncQueues();
    db.run("UPDATE queues SET state = 'PROCESSING' WHERE id = 'default:empty'");

    sink.events.length = 0;
    const claims = lifecycle.claim();
    expect(claims.map((claim) => claim.instanceId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(sink.events).toEqual([
      { type: "instanceStateChanged", instanceId: first.id, state: "RUNNING" },
      { type: "instanceStateChanged", instanceId: second.id, state: "RUNNING" },
      { type: "queueStateChanged", queueId: "default:empty", state: "IDLE" },
    ]);
  });

  test("unknown task and unknown queue raise stable codes", () => {
    expect(() => lifecycle.enqueue("nope:nope", {})).toThrow(CoreError);
    try {
      lifecycle.enqueue("nope:nope", {});
    } catch (err) {
      expect((err as CoreError).code).toBe("TASK_NOT_FOUND");
    }

    try {
      lifecycle.claimQueue("nope:nope");
    } catch (err) {
      expect((err as CoreError).code).toBe("QUEUE_NOT_FOUND");
    }
  });
});

describe("schema migration", () => {
  test("an older control_requests table gains claim_tokens on open", () => {
    const dataDir = makeTempDir("tq-migration-");
    const dbPath = resolveDataDir(dataDir).dbPath;
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE control_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        queue_id TEXT,
        instance_ids TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed_at TEXT
      )
    `);
    legacy.close();

    const db = openDatabase(dbPath);
    insertControlRequest(db, "abort", "default:echo", [
      { instanceId: 7, attempt: 2 },
    ]);
    const row = db
      .query("SELECT claim_tokens FROM control_requests LIMIT 1")
      .get() as { claim_tokens: string };
    expect(JSON.parse(row.claim_tokens)).toEqual([
      { instanceId: 7, attempt: 2 },
    ]);
    closeDatabase(db);
  });
});
