/**
 * CLI construction helper: open the project database and build the core over
 * a lifecycle. Commands call core operations only; they never import
 * `db/queries` for queue or instance state.
 */

import type { DB } from "../db/database.ts";
import {
  bootstrapDataDir,
  closeDatabase,
  configureDatabase,
  openDatabase,
  resolveDataDir,
  type DataDirConfig,
} from "../db/database.ts";
import { createLifecycle } from "../core/lifecycle.ts";
import { createCore, type Core } from "../core/service.ts";

export interface CliCore {
  db: DB;
  core: Core;
  config: DataDirConfig;
  close(): void;
}

export interface OpenCliCoreOptions {
  projectRoot?: string;
  /** Create the data directory and database when missing. */
  bootstrap?: boolean;
}

const silentSink = { publish() {} };

export function openCliCore(
  dataDir: string,
  options: OpenCliCoreOptions = {},
): CliCore {
  const config = resolveDataDir(dataDir);
  if (options.bootstrap) {
    bootstrapDataDir(config);
  }

  const db = openDatabase(config.dbPath);
  configureDatabase(db);

  const lifecycle = createLifecycle({
    db,
    events: silentSink,
    logDir: config.logDir,
    defaultCwd: options.projectRoot ?? process.cwd(),
  });
  const core = createCore({
    db,
    lifecycle,
    projectRoot: options.projectRoot ?? process.cwd(),
    dataDir,
  });

  return {
    db,
    core,
    config,
    close() {
      closeDatabase(db);
    },
  };
}
