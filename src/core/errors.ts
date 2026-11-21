/**
 * Stable core error codes and the error type adapters map to transport
 * failures. Adapters must branch on `code`, never on the message.
 */

import type { ValidationIssue } from "./validation.ts";

export type CoreErrorCode =
  | "TASK_NOT_FOUND"
  | "QUEUE_NOT_FOUND"
  | "INSTANCE_NOT_FOUND"
  | "INVALID_INSTANCE_ID"
  | "INSTANCE_ID_CONFLICT"
  | "INVALID_TRANSITION"
  | "INVALID_CONCURRENCY"
  | "CLEAR_REFUSED_RUNNING"
  | "INPUT_SCHEMA_VIOLATION"
  | "INVALID_CWD"
  | "CONTROL_TIMEOUT";

export interface CoreErrorDetails {
  /** Present for INPUT_SCHEMA_VIOLATION. */
  issues?: ValidationIssue[];
  /** Present for CLEAR_REFUSED_RUNNING. */
  runningIds?: number[];
}

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  /** Present for INPUT_SCHEMA_VIOLATION. */
  readonly issues?: ValidationIssue[];
  /** Present for CLEAR_REFUSED_RUNNING. */
  readonly runningIds?: number[];

  constructor(code: CoreErrorCode, message: string, details: CoreErrorDetails = {}) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.issues = details.issues;
    this.runningIds = details.runningIds;
  }
}
