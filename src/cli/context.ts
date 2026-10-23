/**
 * CLI context parsing.
 *
 * The CLI accepts exactly one context source per invocation:
 * - a single JSON argument (including escaped/quoted JSON);
 * - `@file`, read as JSON relative to the invocation directory;
 * - one or more `name=value` / `name:=value` assignments;
 * - a bare argument, wrapped only when the schema has exactly one required
 *   string property (or kept as a string when the task has no schema).
 *
 * `format: "path"` values are resolved against the invocation directory after
 * parsing and before validation. The core never rewrites paths, so HTTP
 * clients keep full control over the paths they send.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ContextOptions {
  /** Parsed JSON Schema, or null when the task has no input schema. */
  schema: object | null;
  /** Directory the user invoked `tq` from. */
  cwd: string;
}

type Assignment = { name: string; value: unknown };

const ASSIGNMENT = /^([A-Za-z_$][A-Za-z0-9_$.-]*)(:=|=)([\s\S]*)$/;

function assignmentFor(arg: string): Assignment | null {
  const match = ASSIGNMENT.exec(arg);
  if (!match) return null;
  const name = match[1]!;
  const operator = match[2]!;
  const raw = match[3]!;
  if (operator === "=") {
    return { name, value: raw };
  }
  try {
    return { name, value: JSON.parse(raw) };
  } catch (err: any) {
    throw new UsageError(
      `Invalid JSON value for "${name}": ${err?.message ?? "invalid JSON"}`,
    );
  }
}

function isJsonArgument(arg: string): boolean {
  const first = arg.trimStart()[0];
  return first === "{" || first === "[" || first === '"';
}

function readJsonFile(path: string, cwd: string): unknown {
  const absolute = resolve(cwd, path);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf-8");
  } catch (err: any) {
    throw new UsageError(
      `Cannot read context file "${path}": ${err?.message ?? "read failed"}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    throw new UsageError(
      `Invalid JSON in context file "${path}": ${err?.message ?? "invalid JSON"}`,
    );
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    throw new UsageError(`Invalid JSON context: ${err?.message ?? "invalid JSON"}`);
  }
}

function wrapBare(value: string, schema: object | null): unknown {
  if (!schema) return value;

  const required = (schema as { required?: unknown }).required;
  const properties = (schema as { properties?: unknown }).properties;
  if (
    Array.isArray(required) &&
    required.length === 1 &&
    typeof required[0] === "string"
  ) {
    const name = required[0];
    const property =
      properties && typeof properties === "object"
        ? (properties as Record<string, unknown>)[name]
        : undefined;
    if (
      property &&
      typeof property === "object" &&
      (property as { type?: unknown }).type === "string"
    ) {
      return { [name]: value };
    }
  }

  throw new UsageError(
    "A bare argument is only supported when the task has exactly one required string property; pass JSON or name=value assignments",
  );
}

function parseAssignments(args: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const arg of args) {
    const assignment = assignmentFor(arg);
    // `assignmentFor` throws for an invalid `name:=value` payload.
    if (!assignment) {
      throw new UsageError(`Invalid context argument: ${arg}`);
    }
    input[assignment.name] = assignment.value;
  }
  return input;
}

/**
 * Parse CLI context arguments into the JSON value to enqueue.
 *
 * Path resolution is applied here (not in core) so HTTP callers are never
 * surprised by their paths being rewritten.
 */
export function buildContext(args: string[], options: ContextOptions): unknown {
  if (args.length === 0) {
    return {};
  }

  const allAssignments = args.every((arg) => ASSIGNMENT.test(arg));
  if (allAssignments) {
    const input = parseAssignments(args);
    return options.schema
      ? resolveContextPaths(input, options.schema, options.cwd)
      : input;
  }

  if (args.length > 1) {
    throw new UsageError(
      "Cannot mix context sources; pass one JSON argument, one @file, or only name=value assignments",
    );
  }

  const arg = args[0]!;
  let input: unknown;

  if (arg.startsWith("@")) {
    input = readJsonFile(arg.slice(1), options.cwd);
  } else if (isJsonArgument(arg)) {
    input = parseJson(arg);
  } else {
    const wrapped = wrapBare(arg, options.schema);
    return options.schema
      ? resolveContextPaths(wrapped, options.schema, options.cwd)
      : wrapped;
  }

  return options.schema
    ? resolveContextPaths(input, options.schema, options.cwd)
    : input;
}

// ─── Path resolution ─────────────────────────────────────────────────────────

interface SchemaNode {
  type?: unknown;
  format?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

function isSchemaNode(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveNode(value: unknown, schema: SchemaNode, cwd: string): unknown {
  if (Array.isArray(value)) {
    const items = schema.items;
    if (!isSchemaNode(items)) return value;
    if (items.format === "path") {
      return value.map((item) =>
        typeof item === "string" ? resolve(cwd, item) : item,
      );
    }
    return value.map((item) => resolveNode(item, items, cwd));
  }

  if (value && typeof value === "object") {
    const properties = schema.properties;
    if (!properties) return value;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in out) || !isSchemaNode(propertySchema)) continue;
      out[key] = resolveProperty(out[key], propertySchema, cwd);
    }
    return out;
  }

  return value;
}

function resolveProperty(
  value: unknown,
  schema: SchemaNode,
  cwd: string,
): unknown {
  if (schema.format === "path" && typeof value === "string") {
    // `resolve` leaves absolute paths untouched and resolves relative values
    // against the invocation directory.
    return resolve(cwd, value);
  }
  return resolveNode(value, schema, cwd);
}

/**
 * Return a copy of `input` with every string property declared
 * `"format": "path"` made absolute against `cwd`. Path arrays are resolved
 * element by element; nested objects are followed.
 */
export function resolveContextPaths(
  input: unknown,
  schema: object,
  cwd: string,
): unknown {
  return resolveNode(input, schema as SchemaNode, cwd);
}
