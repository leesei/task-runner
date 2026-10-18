/**
 * Log file utilities.
 *
 * Logs are append-only JSONL files, one per instance.
 * Each record: { timestamp, stream: "stdout"|"stderr", text }
 */

import type { DB } from "./database.ts";
import { getInstance } from "./queries.ts";

export interface LogRecord {
  timestamp: string;
  stream: "stdout" | "stderr";
  text: string;
}

export function getLogPath(db: DB, instanceId: number): string | null {
  const instance = getInstance(db, instanceId);
  if (!instance?.log_path) return null;

  const fs = require("node:fs");
  if (!fs.existsSync(instance.log_path)) return null;
  return instance.log_path;
}

export function appendLog(db: DB, instanceId: number, stream: "stdout" | "stderr", text: string): void {
  const instance = getInstance(db, instanceId);
  if (!instance?.log_path) return;

  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    stream,
    text,
  };

  const fs = require("node:fs");
  fs.appendFileSync(instance.log_path, JSON.stringify(record) + "\n");
}

export function readLogFile(logPath: string): LogRecord[] {
  const fs = require("node:fs");
  if (!fs.existsSync(logPath)) return [];

  const content = fs.readFileSync(logPath, "utf-8");
  if (!content.trim()) return [];

  return content
    .split("\n")
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as LogRecord);
}

export function mergeLogRecords(records: LogRecord[]): string {
  return records
    .sort((a, b) => {
      if (a.timestamp < b.timestamp) return -1;
      if (a.timestamp > b.timestamp) return 1;
      return 0;
    })
    .map(r => r.text)
    .join("");
}

export function createLogFile(logDir: string, instanceId: number): string {
  const fs = require("node:fs");
  const logPath = `${logDir}/instance-${instanceId}.jsonl`;
  fs.writeFileSync(logPath, "");
  return logPath;
}

export function deleteLogFile(logPath: string | null): void {
  if (!logPath) return;
  const fs = require("node:fs");
  try { fs.unlinkSync(logPath); } catch {}
}
