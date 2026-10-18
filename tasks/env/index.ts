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
  "-----BEGIN",                                // private key headers
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



function redact(value: string): string {
  return "[REDACTED]";
}

export async function env(opts: { filter?: string; values?: boolean }): Promise<void> {
  const { filter, values = true } = opts;
  const entries = Object.entries(process.env).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [name, value] of entries) {
    if (filter && !name.startsWith(filter)) continue;
    const sensitive = isSensitiveName(name) || (value !== undefined && isSensitiveValue(value));
    if (values) {
      if (sensitive) {
        console.log(`${name}=${redact(value ?? "")}`);
      } else {
        console.log(`${name}=${value ?? ""}`);
      }
    } else {
      console.log(name);
    }
  }
}

export async function runWith(ctx: {
  input: { filter?: string; values?: boolean };
  signal: AbortSignal;
  done: (exitCode: number) => void;
}) {
  try {
    if (ctx.signal.aborted) {
      ctx.done(124);
      return;
    }
    await env({
      filter: ctx.input.filter,
      values: ctx.input.values ?? true,
    });
    ctx.done(0);
  } catch (err: any) {
    if (ctx.signal.aborted) {
      ctx.done(124);
      return;
    }
    console.error(`env: ${err?.message ?? err}`);
    ctx.done(1);
  }
}

export default runWith;
