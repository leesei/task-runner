import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const SENSITIVE_NAME_SUBSTRINGS = [
  "password", "passwd", "pwd",
  "secret", "secret_key", "secret_access_key",
  "api_key", "apikey", "api_key_id",
  "access_key", "access_token", "refresh_token",
  "token", "auth_token",
  "private_key", "private_key_pem",
  "ssh_key", "ssh_private_key",
  "jwt_secret", "jwt_signing_key",
  "client_secret", "client_password",
  "credentials",
  "mongodb_uri", "mongodb_connection_string",
  "database_url", "db_password",
  "redis_password", "redispassword",
  "smtp_password", "mail_password",
  "stripe_secret_key", "stripe_key",
  "slack_bot_token", "slack_token",
  "github_token", "gh_token",
  "pat", "personal_access_token",
  "db_pass", "redis_pass",
];

const SENSITIVE_VALUE_PREFIXES = [
  "sk-",            // OpenAI-style secret keys
  "ghp_", "gho_", "ghu_", "ghs_", "ghr_", // GitHub tokens
  "xoxb-", "xoxp-", "xoxa-", "xoxr-",       // Slack
  "sk_live_", "sk_test_",                     // Stripe
  "AKIA",                                      // AWS access key id
  "-----BEGIN", "-----END",                    // private key headers/footers
  "ya29.",                                     // Google service account
  "Bot ",                                      // Discord bot tokens
];

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  for (const sub of SENSITIVE_NAME_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }
  return false;
}

function isSensitiveValue(value: string): boolean {
  if (!value || value.length < 8) return false;
  if (value.startsWith("AKIA")) return true;
  for (const prefix of SENSITIVE_VALUE_PREFIXES) {
    if (value.startsWith(prefix)) return true;
  }
  // long base64-ish blob
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(value)) return true;
  // looks like a private key block
  if (value.includes("-----BEGIN") && value.includes("PRIVATE KEY-----")) return true;
  // JWT
  if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(value)) return true;
  return false;
}

// Label-aware: "password=VALUE" -> "password=[REDACTED]".
// The global flag is required by replace(); using it with String.match() was
// the bug that made this branch dead code.
const LABELED_SECRET_RE =
  /([A-Za-z_][A-Za-z0-9_.-]*)\s*([=:])\s*(['"]?)([^\s'"]{8,})\3/g;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi;
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BASE64_BLOB_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

function redactLine(line: string): { redacted: boolean; text: string } {
  let changed = false;

  let text = line.replace(
    LABELED_SECRET_RE,
    (match, label: string, separator: string, quote: string, value: string) => {
      if (isSensitiveName(label) || isSensitiveValue(value)) {
        changed = true;
        return `${label}${separator}${quote}[REDACTED]${quote}`;
      }
      return match;
    },
  );

  text = text.replace(
    AUTH_SCHEME_RE,
    (match, scheme: string, value: string) => {
      if (isSensitiveValue(value)) {
        changed = true;
        return `${scheme} [REDACTED]`;
      }
      return match;
    },
  );

  text = text.replace(JWT_RE, (match) => {
    if (isSensitiveValue(match)) {
      changed = true;
      return "[REDACTED]";
    }
    return match;
  });

  text = text.replace(BASE64_BLOB_RE, (match) => {
    if (isSensitiveValue(match)) {
      changed = true;
      return "[REDACTED]";
    }
    return match;
  });

  // Value-only: a long sensitive-looking token on its own line.
  if (!changed && isSensitiveValue(text.trim())) {
    return { redacted: true, text: "[REDACTED]" };
  }
  return { redacted: changed, text };
}


export async function cat(
  filepath: string,
  limit: number = 0,
): Promise<{ lines: string[]; redacted: number }> {
  const lines: string[] = [];
  let redacted = 0;
  const rl = createInterface({
    input: createReadStream(filepath),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (limit > 0 && lines.length >= limit) break;
    const { redacted: r, text } = redactLine(line);
    if (r) redacted++;
    lines.push(text);
  }

  return { lines, redacted };
}

export async function runWith(ctx: {
  input: { filepath: string; limit?: number };
  signal: AbortSignal;
  done: (exitCode: number) => void;
}) {
  try {
    if (ctx.signal.aborted) {
      ctx.done(124);
      return;
    }
    const limit = ctx.input.limit ?? 0;
    const { lines, redacted } = await cat(ctx.input.filepath, limit);
    for (const line of lines) console.log(line);
    if (redacted > 0) {
      console.error(`cat: redacted ${redacted} sensitive value(s)`);
    }
    ctx.done(0);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      console.error(`cat: file not found: ${ctx.input.filepath}`);
      ctx.done(1);
      return;
    }
    if (ctx.signal.aborted) {
      ctx.done(124);
      return;
    }
    console.error(`cat: ${err?.message ?? err}`);
    ctx.done(1);
  }
}

export default runWith;
