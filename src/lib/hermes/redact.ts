/**
 * Redact credential-shaped values from command/config error strings.
 *
 * The office must never print an API key into an HTTP error body, an audit line
 * or a log. Errors from the Hermes CLI can echo argv/config fragments, so every
 * boundary that formats one goes through this helper.
 */

const SECRET_KEY = /(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization)(\s*[:=]\s*)(["']?)([^\s"',}]+)/gi

export function redactSensitive(input: string): string {
  if (!input) return ''
  return input
    .replace(SECRET_KEY, (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}[REDACTED]`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/([a-z]+:\/\/[^\s:/]+:)[^\s@]+(@)/gi, '$1[REDACTED]$2')
}

/** Short, redacted suffix safe to put in an Error message. */
export function errorTail(err: unknown, max = 400): string {
  const e = err as { stderr?: string; message?: string }
  return redactSensitive(String(e?.stderr || e?.message || '').trim()).slice(0, max)
}
