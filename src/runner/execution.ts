/**
 * Execution context, console interception, and log capture.
 *
 * The runner calls a task's default export with { input, signal, done },
 * captures console.log/console.error to JSONL log files, and maps completion
 * to instance state.
 *
 * Each execution runs inside an AsyncLocalStorage scope tagged with the
 * active instance id, so concurrent instances write to the correct log.
 *
 * Ticket 07 additions:
 * - Timeout enforcement: if the task doesn't complete within timeoutMs,
 *   the instance is marked FAILED with reason 'timeout' and does NOT
 *   return to PENDING.
 * - Abort handling: when the abort signal fires, the instance is returned
 *   to PENDING with its attempt number incremented (partial log preserved).
 * - Completion callback: done(exitCode) marks SUCCESS (0) or FAILED (non-zero).
 *   A task that returns without calling done is treated as exit code 0.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { DB } from "../db/database.ts";
import { appendLog, createLogFile } from "../db/logs.ts";
import {
  updateInstanceState,
  getInstance,
  incrementAttempt,
} from "../db/queries.ts";
import { emitInstanceStateChanged } from "../api/index.ts";
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
  return instanceStore.getStore() ?? null;
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
    if (!ctx) {
      originalLog.call(console, ...args);
      return;
    }
    const text = args.map(a => String(a)).join(" ");
    appendLog(ctx.db, ctx.instanceId, "stdout", text);
    originalLog.call(console, ...args);
  };

  console.error = function (...args: unknown[]) {
    const ctx = getCurrentInstance();
    if (!ctx) {
      originalError.call(console, ...args);
      return;
    }
    const text = args.map(a => String(a)).join(" ");
    appendLog(ctx.db, ctx.instanceId, "stderr", text);
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

/**
 * Complete an instance only if it is still RUNNING. An aborted or timed-out
 * instance may have been moved to PENDING/FAILED already; late writes from the
 * superseded attempt must not overwrite that state.
 */
function finishInstance(
  db: DB,
  instanceId: number,
  state: InstanceState,
  exitCode?: number,
  failureReason?: string,
): boolean {
  const instance = getInstance(db, instanceId);
  if (!instance || instance.state !== "RUNNING") return false;

  updateInstanceState(db, instanceId, state, exitCode, failureReason);
  emitInstanceStateChanged(instanceId, state);
  return true;
}

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
  abort: () => void,
): Promise<void> {
  // Create log file
  const logPath = createLogFile(logDir, instanceId);

  // Update instance with log path
  db.run("UPDATE instances SET log_path = ? WHERE id = ?", [logPath, instanceId]);

  // Flag to track if done was called
  let completed = false;
  let timedOut = false;

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
        finishInstance(db, instanceId, "SUCCESS");
      } else {
        finishInstance(db, instanceId, "FAILED", exitCode);
      }
    },
  };

  // Set up timeout
  if (task.timeoutMs > 0) {
    const timeoutHandle = setTimeout(() => {
      if (completed) return;
      timedOut = true;
      completed = true;
      // Timeout: mark FAILED with reason 'timeout', do NOT return to PENDING
      finishInstance(db, instanceId, "FAILED", undefined, "timeout");
      abort();
    }, task.timeoutMs);

    // Clear timeout on completion
    const originalDone = ctx.done;
    ctx.done = (exitCode: number) => {
      clearTimeout(timeoutHandle);
      originalDone(exitCode);
    };
  }

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
          finishInstance(db, instanceId, "FAILED", 1, "no_default_export");
        }
        return;
      }

      // Run the task function
      try {
        await taskFn(ctx);

        // If task returns without calling done, treat as success
        if (!completed) {
          finishInstance(db, instanceId, "SUCCESS");
        }
      } catch (err: any) {
        if (!completed) {
          const message = err?.message ?? String(err);
          console.error(`Task ${task.id}: ${message}`);
          finishInstance(db, instanceId, "FAILED", 1, message);
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

  // Return to PENDING with incremented attempt number.
  // Partial log is preserved (log file is not deleted).
  incrementAttempt(db, instanceId);
  updateInstanceState(db, instanceId, "PENDING");
}
