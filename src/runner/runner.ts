/**
 * Task runner loop.
 *
 * The runner consumes durable control requests and claims work from the
 * lifecycle. It owns the AbortController registry (keyed by
 * `instanceId:attempt`), the reload callback, and polling. It never writes
 * queue or instance state.
 */

import type { DB } from "../db/database.ts";
import {
  getControlRequestTokens,
  getPendingControlRequests,
  markControlRequestConsumed,
} from "../db/queries.ts";
import type { Lifecycle } from "../core/lifecycle.ts";
import { executeTask } from "./execution.ts";

export interface RunnerConfig {
  db: DB;
  lifecycle: Lifecycle;
  pollIntervalMs?: number;
  /** Time a cancelled attempt gets to settle before the runner moves on. */
  abortGraceMs?: number;
  onReload?: () => void | Promise<void>;
}

interface ControllerEntry {
  controller: AbortController;
  settled: Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_ABORT_GRACE_MS = 5000;

export function createRunner(config: RunnerConfig) {
  const { db, lifecycle } = config;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const abortGraceMs = config.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  const controllers = new Map<string, ControllerEntry>();

  function controllerKey(token: { instanceId: number; attempt: number }): string {
    return `${token.instanceId}:${token.attempt}`;
  }

  async function processControlRequests(): Promise<void> {
    const requests = getPendingControlRequests(db);

    for (const request of requests) {
      if (request.kind === "abort" && request.queue_id) {
        const tokens = getControlRequestTokens(request);
        // No RUNNING work when the request was written: abort is an
        // idempotent stop, so the queue still ends STOPPED. A request that
        // recorded tokens is fenced; stale tokens change nothing.
        const result =
          tokens.length === 0
            ? lifecycle.abortQueue(request.queue_id)
            : lifecycle.abortQueue(request.queue_id, tokens);

        if (!result.discarded) {
          const entries = result.cancelled
            .map((token) => controllers.get(controllerKey(token)))
            .filter((entry): entry is ControllerEntry => entry !== undefined);

          for (const entry of entries) {
            entry.controller.abort();
          }

          // Cooperative cancellation: give the task a bounded chance to settle
          // before the runner claims the returned instance again. A task that
          // ignores the signal keeps running, but its late writes are fenced.
          if (entries.length > 0 && abortGraceMs > 0) {
            await Promise.race([
              Promise.all(entries.map((entry) => entry.settled)),
              Bun.sleep(abortGraceMs),
            ]);
          }
        }
      } else if (request.kind === "reload") {
        try {
          await config.onReload?.();
        } catch (err) {
          console.error("Reload request failed:", err);
        }
      }

      markControlRequestConsumed(db, request.id);
    }
  }

  function launch(claims: ReturnType<Lifecycle["claim"]>): number {
    for (const claim of claims) {
      const key = controllerKey(claim);
      const controller = new AbortController();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });

      controllers.set(key, { controller, settled });

      executeTask(claim, lifecycle, controller.signal, () => controller.abort())
        .catch((err) => {
          console.error(
            `Task execution error for instance ${claim.instanceId} attempt ${claim.attempt}:`,
            err,
          );
        })
        .finally(() => {
          if (controllers.get(key)?.controller === controller) {
            controllers.delete(key);
          }
          settle();
        });
    }

    return claims.length;
  }

  return {
    /** Run one iteration. Returns the number of instances launched. */
    async runOnce(): Promise<number> {
      await processControlRequests();
      return launch(lifecycle.claim());
    },

    /** Run continuously, polling for work. */
    async runContinuous(): Promise<void> {
      while (true) {
        await this.runOnce();
        await Bun.sleep(pollIntervalMs);
      }
    },

    /** Visible for tests and shutdown paths. */
    activeControllerKeys(): string[] {
      return [...controllers.keys()];
    },
  };
}
