/**
 * Input validation for task contexts.
 *
 * Validation is a core operation: the CLI and the HTTP API both call
 * `enqueueTask`, which validates before creating an instance. The supported
 * JSON Schema subset is the one task authors use (`type`, `properties`,
 * `required`, `enum`, `minimum`, `maximum`, `default`, `description`,
 * `format`); unknown keywords are ignored.
 *
 * `format: "path"` is an annotation for the CLI, which resolves path values
 * against the invocation directory before enqueueing. The core never touches
 * the filesystem and therefore never rewrites paths.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  /** The normalized value (defaults applied). Always safe to store. */
  value: unknown;
  issues: ValidationIssue[];
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  useDefaults: true,
  // Formats are annotations in v1 (`path` is handled by the CLI). Unknown
  // formats must not turn a valid context into a violation.
  validateFormats: false,
});

// Registered so a `format: "path"` schema is accepted even if format
// assertion is enabled later. It is never an assertion on its own.
ajv.addFormat("path", true);

const compiled = new Map<string, ValidateFunction>();

function compile(schemaJson: string, schema: object): ValidateFunction | null {
  const cached = compiled.get(schemaJson);
  if (cached) return cached;
  try {
    const validate = ajv.compile(schema);
    compiled.set(schemaJson, validate);
    return validate;
  } catch {
    return null;
  }
}

function pointerFor(error: ErrorObject): string {
  const base = error.instancePath;
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required" && typeof params.missingProperty === "string") {
    return `${base}/${params.missingProperty}` || `/${params.missingProperty}`;
  }
  if (
    error.keyword === "additionalProperties" &&
    typeof params.additionalProperty === "string"
  ) {
    return `${base}/${params.additionalProperty}`;
  }
  return base === "" ? "(root)" : base;
}

function toIssue(error: ErrorObject): ValidationIssue {
  return {
    path: pointerFor(error),
    message: error.message ?? "is invalid",
  };
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

/**
 * Validate a context against a task's stored schema.
 *
 * - No schema (`null`) accepts the context as-is.
 * - Unknown keywords are ignored.
 * - Defaults declared in the schema are applied to the returned value; the
 *   caller's value is never mutated.
 * - A schema that cannot be compiled is reported as a violation instead of
 *   silently accepting arbitrary input.
 */
export function validateContext(
  schemaJson: string | null,
  input: unknown,
): ValidationResult {
  const value = cloneJson(input);
  if (schemaJson === null) {
    return { value, issues: [] };
  }

  let schema: unknown;
  try {
    schema = JSON.parse(schemaJson);
  } catch {
    return {
      value,
      issues: [
        {
          path: "(schema)",
          message: "Task input schema is not valid JSON",
        },
      ],
    };
  }

  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return {
      value,
      issues: [
        {
          path: "(schema)",
          message: "Task input schema must be a JSON object",
        },
      ],
    };
  }

  const validate = compile(schemaJson, schema);
  if (!validate) {
    return {
      value,
      issues: [
        {
          path: "(schema)",
          message: "Task input schema could not be compiled",
        },
      ],
    };
  }

  if (validate(value)) {
    return { value, issues: [] };
  }

  return {
    value,
    issues: (validate.errors ?? []).map(toIssue),
  };
}

/** Exposed for adapters that need to read a schema without validating. */
export function parseSchema(schemaJson: string | null): object | null {
  if (schemaJson === null) return null;
  try {
    const schema = JSON.parse(schemaJson);
    if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
      return schema as object;
    }
    return null;
  } catch {
    return null;
  }
}
