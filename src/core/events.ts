/**
 * Lifecycle event vocabulary and the injected sink.
 *
 * The lifecycle publishes after its transaction commits: instance events
 * first (ascending instance id), then queue events (ascending queue id). The
 * bus isolates subscriber failures so a bad listener cannot fail a transition.
 *
 * Events are notifications, not truth. A dashboard reads a snapshot and then
 * subscribes.
 */

import type { InstanceState, QueueState } from "../db/schema.ts";

export type LifecycleEvent =
  | { type: "instanceStateChanged"; instanceId: number; state: InstanceState }
  | { type: "queueStateChanged"; queueId: string; state: QueueState }
  | { type: "instancesCleared"; queueId: string; instanceIds: number[] };

export interface EventSink {
  publish(event: LifecycleEvent): void;
}

export interface EventBus extends EventSink {
  subscribe(listener: (event: LifecycleEvent) => void): () => void;
}

/**
 * Create an in-process fan-out bus. `publish` never throws: a subscriber that
 * throws is skipped, and the remaining subscribers still receive the event.
 */
export function createEventBus(): EventBus {
  const listeners = new Set<(event: LifecycleEvent) => void>();

  return {
    publish(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // A subscriber must not be able to fail a lifecycle transition.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
