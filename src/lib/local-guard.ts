import { NextResponse } from 'next/server'

/**
 * Host/Origin primitives for the office's central API ingress policy.
 *
 * Every API method — including GET — must name a trusted Host. Mutations must
 * additionally carry an Origin that EXACTLY matches the trusted origin:
 * same scheme, host and (where configured) port. This stops:
 *
 *   1. DNS rebinding / foreign Host requests reading office state (Host gate).
 *   2. Cross-site form/fetch writes (exact Origin gate).
 *
 * It is NOT authentication. There is no login: any local process that can reach
 * the port can supply trusted headers. The app is for local single-user use and
 * must not be exposed beyond loopback without a real auth layer.
 *
 * `ALLOWED_ORIGINS` entries (comma-separated):
 *   https://office.example.com:8443   exact scheme + host + port
 *   office.example.com:3300           exact host + port, plain http
 *   office.example.com                exact host, plain http, any port (legacy)
 *
 * `X-Forwarded-*` headers are never consulted; a trusted reverse proxy must be
 * configured to preserve the real Host/Origin, or authentication must be added.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

type ParsedOrigin = { protocol: 'http:' | 'https:'; hostname: string; port: string; anyPort: boolean }

function configuredRaw(allowedRaw?: string): string {
  return allowedRaw ?? process.env.ALLOWED_ORIGINS ?? ''
}

function effectivePort(u: URL): string {
  if (u.port) return u.port
  return u.protocol === 'https:' ? '443' : '80'
}

function normalizeHostname(h: string): string {
  return h.trim().toLowerCase()
}

function parseConfiguredEntry(entry: string): ParsedOrigin | null {
  const raw = entry.trim().toLowerCase()
  if (!raw) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw)
  const candidate = hasScheme ? raw : `http://${raw}`
  let u: URL
  try {
    u = new URL(candidate)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  if (u.pathname !== '/' || u.search || u.hash) return null
  const anyPort = !hasScheme && !/:\d+$/.test(raw)
  return {
    protocol: u.protocol,
    hostname: normalizeHostname(u.hostname),
    port: effectivePort(u),
    anyPort,
  }
}

function configuredOrigins(allowedRaw?: string): ParsedOrigin[] {
  return configuredRaw(allowedRaw)
    .split(',')
    .map(parseConfiguredEntry)
    .filter((x): x is ParsedOrigin => x !== null)
}

function parseHostHeader(hostHeader: string | null): URL | null {
  if (!hostHeader || /[\r\n]/.test(hostHeader)) return null
  try {
    const u = new URL(`http://${hostHeader}`)
    if (u.username || u.password) return null
    if (u.pathname !== '/' || u.search || u.hash) return null
    return u
  } catch {
    return null
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK.has(normalizeHostname(hostname))
}

function hostMatchesEntry(host: URL, entry: ParsedOrigin): boolean {
  if (normalizeHostname(host.hostname) !== entry.hostname) return false
  if (entry.anyPort) return true
  // The Host header carries no scheme. An omitted port is compatible with a
  // configured default port (80 for http, 443 for https); a non-default port
  // must be written explicitly in both the Host and the configured origin.
  if (!host.port) return entry.port === '80' || entry.port === '443'
  return effectivePort(host) === entry.port
}

/** Is this raw `Host` header one we are willing to answer at all? */
export function isTrustedHost(hostHeader: string | null, allowedRaw?: string): boolean {
  const host = parseHostHeader(hostHeader)
  if (!host) return false
  if (isLoopbackHostname(host.hostname)) return true
  return configuredOrigins(allowedRaw).some((entry) => hostMatchesEntry(host, entry))
}

/**
 * Does this Origin exactly match the request Host and a trusted configured
 * origin? Loopback is trusted for both http and https; configured origins must
 * match the configured scheme/host/port exactly.
 */
export function isTrustedOrigin(
  hostHeader: string | null,
  originHeader: string | null,
  allowedRaw?: string,
): boolean {
  const host = parseHostHeader(hostHeader)
  if (!host) return false
  if (!originHeader || /[\r\n]/.test(originHeader)) return false
  let origin: URL
  try {
    origin = new URL(originHeader)
  } catch {
    return false
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false
  // Same-origin: the Origin must name the request Host. The Host header has no
  // scheme, so an omitted Host port is compatible with the Origin's default port.
  if (normalizeHostname(origin.hostname) !== normalizeHostname(host.hostname)) return false
  if (host.port && effectivePort(origin) !== host.port) return false
  if (isLoopbackHostname(host.hostname)) {
    return isLoopbackHostname(origin.hostname)
  }
  return configuredOrigins(allowedRaw).some(
    (entry) =>
      origin.protocol === entry.protocol &&
      normalizeHostname(origin.hostname) === entry.hostname &&
      hostMatchesEntry(host, entry) &&
      (entry.anyPort ? origin.host === host.host : effectivePort(origin) === entry.port),
  )
}

/**
 * Backwards-compatible predicate used by the self-tests and doctor mirror.
 * Both Host and Origin are required, and the Origin must be exact.
 */
export function localOriginAllowed(
  hostHeader: string | null,
  originHeader: string | null,
  allowedRaw?: string,
): boolean {
  return isTrustedHost(hostHeader, allowedRaw) && isTrustedOrigin(hostHeader, originHeader, allowedRaw)
}

/**
 * Legacy write-only guard. New routes use `assertApiRequest` from
 * `@/lib/api-policy` so safe-mode gating is central. This stays for any external
 * caller that only needs the ingress checks.
 */
export function assertLocalWriteRequest(req: Request): NextResponse | null {
  const host = req.headers.get('host')
  const origin = req.headers.get('origin')
  if (localOriginAllowed(host, origin)) return null
  return NextResponse.json(
    {
      error: {
        code: isTrustedHost(host) ? 'forbidden_origin' : 'forbidden_host',
        message: isTrustedHost(host)
          ? `Origin "${origin ?? '(không có)'}" không được phép ghi. Origin phải trùng với Host và có trong ALLOWED_ORIGINS (khớp chính xác giao thức/host/cổng), sau đó khởi động lại.`
          : `Host "${host ?? '(không có)'}" không đáng tin cậy. Chỉ chấp nhận loopback hoặc host trong ALLOWED_ORIGINS.`,
        status: 403,
      },
    },
    { status: 403 },
  )
}
