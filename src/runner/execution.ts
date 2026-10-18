/**
 * Execution context and console interception.
 *
 * The execution context passed to task functions:
 *   { input, signal, done }
 *
 * Console interception via AsyncLocalStorage so concurrent instances
 * write to the correct log file.
 */

export interface ExecutionContext<TInput> {
  input: TInput;
  signal: AbortSignal;
  done: (exitCode: number) => void;
}

// AsyncLocalStorage for tracking the current instance
import { AsyncLocalStorage } from "node:async_hooks";

export interface InstanceContext {
  instanceId: number;
  db: any; // Will be properly typed
}

export const instanceStore = new AsyncLocalStorage<InstanceContext | null>();

/**
 * Wrap a task execution in an AsyncLocalStorage context.
 */
export function runInInstanceContext<T>(
  context: InstanceContext,
  fn: () => T,
): T {
  return instanceStore.run(context, fn);
}

/**
 * Get the current instance context, if any.
 */
export function getCurrentInstance(): InstanceContext | null {
  return instanceStore.getStore();
}
