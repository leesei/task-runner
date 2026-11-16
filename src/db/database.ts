/**
 * Database connection and bootstrap for the task runner.
 *
 * Opens (or creates) the SQLite database in the data directory,
 * runs the schema migration, and provides query methods.
 */

import { Database } from "bun:sqlite";
import { SCHEMA } from "./schema.ts";

export interface DataDirConfig {
  dataDir: string;
  dbPath: string;
  logDir: string;
}

export function resolveDataDir(dataDir: string): DataDirConfig {
  const dbPath = `${dataDir}/taskrunner.db`;
  const logDir = `${dataDir}/logs`;
  return { dataDir, dbPath, logDir };
}

export function bootstrapDataDir(config: DataDirConfig): void {
  const fs = require("node:fs");
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
  if (!fs.existsSync(config.logDir)) {
    fs.mkdirSync(config.logDir, { recursive: true });
  }
}

export type DB = Database;

/**
 * Apply additive migrations for databases created by an older build.
 * `CREATE TABLE IF NOT EXISTS` never adds columns, so every new column needs
 * an explicit, idempotent ALTER.
 */
function migrate(db: DB): void {
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN entry_point TEXT");
  } catch {
    // Column already exists.
  }
  try {
    db.exec("ALTER TABLE control_requests ADD COLUMN claim_tokens TEXT");
  } catch {
    // Column already exists.
  }
  try {
    db.exec("ALTER TABLE instances ADD COLUMN cwd TEXT");
  } catch {
    // Column already exists.
  }
}

export function openDatabase(dbPath: string): DB {
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function closeDatabase(db: DB): void {
  db.close();
}

// Additional PRAGMA settings for performance
export function configureDatabase(db: DB): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA cache_size = -64000"); // 64MB cache

  // Older databases need the additive columns; `openDatabase` normally does
  // this, but configureDatabase is also called directly by tests and tools.
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN entry_point TEXT");
  } catch {
    // Column already exists or another non-fatal error — skip
  }
  try {
    db.exec("ALTER TABLE control_requests ADD COLUMN claim_tokens TEXT");
  } catch {
    // Column already exists or another non-fatal error — skip
  }
  try {
    db.exec("ALTER TABLE instances ADD COLUMN cwd TEXT");
  } catch {
    // Column already exists or another non-fatal error — skip
  }
}
