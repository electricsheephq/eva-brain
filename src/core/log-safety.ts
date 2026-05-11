/**
 * Helpers for console/log output that may include values derived from config,
 * environment variables, provider responses, or thrown errors.
 */

const SENSITIVE_KEY_RE = /(api[_-]?key|token|secret|password|passwd|credential|authorization|database[_-]?url)/i;
const PG_URL_RE = /\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi;
const USERINFO_URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\/\s"'<>:@]+):([^\/\s"'<>@]+)@/gi;
const SECRET_ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|DATABASE_URL)[A-Z0-9_]*)\s*[:=]\s*["']?[^"',\s}]+/gi;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const COMMON_KEY_RE = /\b(sk-[A-Za-z0-9_-]{12,}|gbrain_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g;

export function sanitizeLogText(value: unknown): string {
  const raw = value instanceof Error
    ? `${value.name || 'Error'}: ${value.message || 'command failed'}`
    : typeof value === 'string'
      ? value
      : String(value);
  return raw
    .replace(PG_URL_RE, '<redacted-postgres-url>')
    .replace(USERINFO_URL_RE, '$1***:***@')
    .replace(SECRET_ASSIGNMENT_RE, '$1=<redacted>')
    .replace(BEARER_RE, '$1<redacted>')
    .replace(COMMON_KEY_RE, '<redacted-secret>');
}

export function sanitizeErrorForLog(value: unknown): string {
  if (value instanceof Error) return sanitizeLogText(`${value.name || 'Error'}: ${value.message || 'command failed'}`);
  return sanitizeLogText(value);
}

export function safePublicModelLabel(model: unknown): string {
  if (typeof model !== 'string') return '<configured-model>';
  const trimmed = model.trim();
  return /^[a-z0-9._-]+:[A-Za-z0-9._:@/-]+$/.test(trimmed)
    ? trimmed
    : '<configured-model>';
}

export function sanitizeJsonForLog<T>(value: T): T {
  if (typeof value === 'string') return sanitizeLogText(value) as unknown as T;
  if (Array.isArray(value)) return value.map(v => sanitizeJsonForLog(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '<redacted>' : sanitizeJsonForLog(v);
    }
    return out as T;
  }
  return value;
}
