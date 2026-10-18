/**
 * Execution context, console interception, and log capture.
 *
 * The runner calls a task's default export with { input, signal, done },
 * captures console.log/console.error to JSONL log files, and maps completion
 * to instance state.
 *
 * Each execution runs inside an AsyncLocalStorage scope tagged with the
 * active instance id, so concurrent instances write to the correct log.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { DB } from "../db/database.ts";
import { appendLog, createLogFile } from "../db/logs.ts";
import { updateInstanceState, getInstance } from "../db/queries.ts";
import type { InstanceState } from "../db/schema.ts";

// ─── Execution Context ─────────────────────────────────────────────────────────

export interface ExecutionContext<TInput = unknown> {
  input: TInput;
  signal: AbortSignal;
  done: (exitCode: number) => void;
}

// ─── AsyncLocalStorage for instance tracking ───────────────────────────────────

export interface InstanceContext {
  instanceId: number;
  db: DB;
}

const instanceStore = new AsyncLocalStorage<InstanceContext | null>();

export function runInInstanceContext<T>(
  context: InstanceContext,
  fn: () => T,
): T {
  return instanceStore.run(context, fn);
}

export function getCurrentInstance(): InstanceContext | null {
  return instanceStore.getStore();
}

// ─── Console Interception ──────────────────────────────────────────────────────

let originalLog: (...args: unknown[]) => void = console.log;
let originalError: (...args: unknown[]) => void = console.error;
let interceptionActive = false;

export function installConsoleInterception(): void {
  if (interceptionActive) return;

  originalLog = console.log;
  originalError = console.error;

  console.log = function (...args: unknown[]) {
    const ctx = getCurrentInstance();
    const text = args.map(a => String(a)).join(" ");

    if (ctx) {
      appendLog(ctx.db, ctx.instanceId, "stdout", text);
    }
    originalLog.call(console, ...args);
  };

  console.error = function (...args: unknown[]) {
    const ctx = getCurrentInstance();
    const text = args.map(a => String(a)).join(" ");

    if (ctx) {
      appendLog(ctx.db, ctx.instanceId, "stderr", text);
    }
    originalError.call(console, ...args);
  };

  interceptionActive = true;
}

export function uninstallConsoleInterception(): void {
  if (!interceptionActive) return;

  console.log = originalLog;
  console.error = originalError;
  interceptionActive = false;
}

// ─── Task Execution ────────────────────────────────────────────────────────────

export interface TaskDefinition {
  id: string;
  entryPoint: string;  // Resolved path to index.ts
  timeoutMs: number;
}

export async function executeTask(
  db: DB,
  instanceId: number,
  task: TaskDefinition,
  input: unknown,
  signal: AbortSignal,
  logDir: string,
): Promise<void> {
  // Create log file
  const logPath = createLogFile(logDir, instanceId);

  // Update instance with log path
  db.run("UPDATE instances SET log_path = ? WHERE id = ?", [logPath, instanceId]);

  // Mark as RUNNING
  updateInstanceState(db, instanceId, "RUNNING");

  // Flag to track if done was called
  let completed = false;

  const ctx: ExecutionContext<typeof input> = {
    input,
    signal,
    done: (exitCode: number) => {
      if (completed) {
        // Second done call — record warning but ignore
        console.warn(`Instance ${instanceId}: second done() call ignored (exitCode was ${exitCode})`);
        return;
      }
      completed = true;

      if (exitCode === 0) {
        updateInstanceState(db, instanceId, "SUCCESS");
      } else {
        updateInstanceState(db, instanceId, "FAILED", exitCode);
      }
    },
  };

  // Run the task inside the AsyncLocalStorage context
  const result = await runInInstanceContext(
    { instanceId, db },
    async () => {
      // Import the task entrypoint dynamically
      // Use cache-busting query parameter to pick up changes on reload
      const importPath = task.entryPoint;
      const module = await import(importPath);

      const taskFn = module.default;
      if (!taskFn || typeof taskFn !== "function") {
        console.error(`Task ${task.id}: no default export found`);
        if (!completed) {
          updateInstanceState(db, instanceId, "FAILED", 1, "no_default_export");
        }
        return;
      }

      // Run the task function
      try {
        await taskFn(ctx);

        // If task returns without calling done, treat as success
        if (!completed) {
          updateInstanceState(db, instanceId, "SUCCESS");
        }
      } catch (err: any) {
        if (!completed) {
          const message = err?.message ?? String(err);
          console.error(`Task ${task.id}: ${message}`);
          updateInstanceState(db, instanceId, "FAILED", 1, message);
        }
      }
    },
  );

  return result;
}

// ─── Abort Handling ────────────────────────────────────────────────────────────

export async function abortInstance(
  db: DB,
  instanceId: number,
  gracePeriodMs: number,
): Promise<void> {
  const instance = getInstance(db, instanceId);
  if (!instance || instance.state !== "RUNNING") return;

  // The runner sets the abort signal on the instance's context.
  // The task is expected to honor it cooperatively.
  // We just mark it as PENDING after the grace period.

  // For now, immediately return to PENDING.
  // The grace period is handled by the runner loop in ticket 06/07.
  updateInstanceState(db, instanceId, "PENDING");
}
