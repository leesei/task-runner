/**
 * Execution: task module import, timeout enforcement, console interception,
 * and append-only log capture.
 *
 * The runner hands over a `Claim` and an `AbortSignal`. Execution owns
 * everything between claim and completion; it never writes queue or instance
 * state except through `lifecycle.finishRun(claim, outcome)`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import type { Claim, Lifecycle, RunOutcome } from "../core/lifecycle.ts";
import { appendLogLine, ensureLogFile } from "../db/logs.ts";

// ─── Execution Context ─────────────────────────────────────────────────────────

export interface ExecutionContext<TInput = unknown> {
  input: TInput;
  /** Absolute working directory of the instance; never the process cwd. */
  cwd: string;
  signal: AbortSignal;
  done: (exitCode: number) => void;
}

// ─── AsyncLocalStorage for instance tracking ───────────────────────────────────

export interface InstanceContext {
  instanceId: number;
  attempt: number;
  logPath: string;
  /** False once this attempt is superseded; late output is discarded. */
  active: boolean;
}

const instanceStore = new AsyncLocalStorage<InstanceContext>();

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
    if (ctx.active) {
      appendLogLine(ctx.logPath, "stdout", args.map(String).join(" "));
    }
    originalLog.call(console, ...args);
  };

  console.error = function (...args: unknown[]) {
    const ctx = getCurrentInstance();
    if (!ctx) {
      originalError.call(console, ...args);
      return;
    }
    if (ctx.active) {
      appendLogLine(ctx.logPath, "stderr", args.map(String).join(" "));
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

let importCounter = 0;

function importSpecifier(entryPoint: string, attempt: number): string {
  const version = `${Date.now()}-${attempt}-${++importCounter}`;
  const separator = entryPoint.includes("?") ? "&" : "?";
  return `${entryPoint}${separator}v=${version}`;
}

/**
 * Execute one claim. Completion is reported through the fenced
 * `finishRun(claim, outcome)`; a stale attempt's result is ignored.
 */
export async function executeTask(
  claim: Claim,
  lifecycle: Lifecycle,
  signal: AbortSignal,
  abort: () => void,
): Promise<void> {
  // Append across attempts: never truncate an earlier attempt's output.
  ensureLogFile(claim.logPath);

  const context: InstanceContext = {
    instanceId: claim.instanceId,
    attempt: claim.attempt,
    logPath: claim.logPath,
    active: true,
  };

  let completed = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const finish = (outcome: RunOutcome): void => {
    if (completed) return;
    completed = true;
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    const result = lifecycle.finishRun(claim, outcome);
    if (!result.applied) {
      console.warn(
        `Instance ${claim.instanceId} attempt ${claim.attempt}: completion ignored (${result.ignored ?? "unknown"})`,
      );
    }
  };

  const ctx: ExecutionContext = {
    input: claim.input,
    cwd: claim.cwd,
    signal,
    done: (exitCode: number) => {
      if (completed) {
        console.warn(
          `Instance ${claim.instanceId}: second done() call ignored (exitCode ${exitCode})`,
        );
        return;
      }
      finish(
        exitCode === 0
          ? { kind: "success" }
          : { kind: "failure", exitCode },
      );
    },
  };

  const onAbort = (): void => {
    // The abort already returned the instance to PENDING in the lifecycle.
    // Stop accepting this attempt's late output; the completion fence stops
    // its late state writes.
    context.active = false;
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });

  // The directory is per-instance data. The runner never changes the process
  // cwd: another task could observe it after an await. A directory that has
  // disappeared since enqueue is an explicit failure, not a silent fallback.
  try {
    if (!statSync(claim.cwd).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    const message = `Task ${claim.taskId}: working directory not available: ${claim.cwd}`;
    appendLogLine(claim.logPath, "stderr", message);
    console.error(message);
    finish({ kind: "failure", exitCode: 1, reason: "cwd_not_found" });
    signal.removeEventListener("abort", onAbort);
    return;
  }

  if (claim.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      // Commit the timeout before firing the signal: a done() from the task's
      // abort handler must be a late completion, not the winner.
      finish({ kind: "timeout" });
      abort();
    }, claim.timeoutMs);
  }

  try {
    await runInInstanceContext(context, async () => {
      const module = await import(importSpecifier(claim.entryPoint, claim.attempt));

      const taskFn = module.default;
      if (!taskFn || typeof taskFn !== "function") {
        console.error(`Task ${claim.taskId}: no default export found`);
        finish({ kind: "failure", exitCode: 1, reason: "no_default_export" });
        return;
      }

      try {
        await taskFn(ctx);
        if (!completed) {
          finish({ kind: "success" });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!completed) {
          console.error(`Task ${claim.taskId}: ${message}`);
          finish({ kind: "failure", exitCode: 1, reason: message });
        } else {
          console.warn(
            `Instance ${claim.instanceId} attempt ${claim.attempt}: task threw after completion (ignored): ${message}`,
          );
        }
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!completed) {
      console.error(`Task ${claim.taskId}: ${message}`);
      finish({ kind: "failure", exitCode: 1, reason: message });
    } else {
      console.warn(
        `Instance ${claim.instanceId} attempt ${claim.attempt}: task threw after completion (ignored): ${message}`,
      );
    }
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    signal.removeEventListener("abort", onAbort);
  }
}
