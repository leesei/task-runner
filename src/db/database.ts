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

export function openDatabase(dbPath: string): DB {
  const db = new Database(dbPath);
  db.exec(SCHEMA);
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
}
