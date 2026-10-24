/**
 * Small test harness: build the lifecycle, core, and event bus over a
 * temporary database. Keeps the seam tests focused on behavior rather than
 * construction noise.
 */

import type { DB } from "../../src/db/database.ts";
import { resolveDataDir } from "../../src/db/database.ts";
import { createLifecycle, type Lifecycle } from "../../src/core/lifecycle.ts";
import { createCore, type Core } from "../../src/core/service.ts";
import { createEventBus, type EventBus } from "../../src/core/events.ts";

export interface TestHarness {
  lifecycle: Lifecycle;
  core: Core;
  events: EventBus;
}

export function createHarness(
  db: DB,
  dataDir: string,
  projectRoot: string,
  events: EventBus = createEventBus(),
): TestHarness {
  const lifecycle = createLifecycle({
    db,
    events,
    logDir: resolveDataDir(dataDir).logDir,
  });
  const core = createCore({ db, lifecycle, projectRoot, dataDir });
  return { lifecycle, core, events };
}
