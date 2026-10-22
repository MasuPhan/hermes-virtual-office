import { NextResponse } from 'next/server'
import { isTrustedHost, isTrustedOrigin } from './local-guard'

/**
 * CENTRAL API POLICY — one place decides who may read, who may write, and which
 * writes are dangerous.
 *
 * Every exported route handler calls `assertApiRequest(req, access)` first, and
 * `src/middleware.ts` applies the Host gate to every `/api/*` request as a
 * defence in depth. A route that forgets the handler call still cannot be read
 * through an untrusted Host; a route that forgets the middleware is still gated
 * for direct handler tests.
 *
 * Access levels:
 *   read            trusted Host only (all GET/HEAD/OPTIONS).
 *   office-write    trusted Host + exact trusted Origin; allowed in SAFE mode.
 *                   Only for the office's own SQLite state (name/avatars).
 *   management-write trusted Host + Origin + HVO_MANAGEMENT_MODE=write.
 *                   Any real Hermes mutation or LLM/agent call.
 *   privileged      management-write PLUS HVO_ALLOW_PRIVILEGED=1. Destructive
 *                   or installation-wide actions (kill, selfrepair, restart,
 *                   pause-all, fallback chain).
 *
 * Authentication does not exist. This policy is an ingress/CSRF and
 * blast-radius fence for a local single-user tool; it does not make a public
 * port safe.
 */

export type ApiAccess = 'read' | 'office-write' | 'management-write' | 'privileged'

export type ManagementMode = 'safe' | 'write'

export function managementMode(): ManagementMode {
  const raw = (process.env.HVO_MANAGEMENT_MODE || 'safe').trim().toLowerCase()
  return raw === 'write' || raw === 'read-write' || raw === 'rw' ? 'write' : 'safe'
}

export function managementWritesEnabled(): boolean {
  return managementMode() === 'write'
}

export function privilegedActionsEnabled(): boolean {
  const raw = (process.env.HVO_ALLOW_PRIVILEGED || '').trim().toLowerCase()
  return managementWritesEnabled() && (raw === '1' || raw === 'true' || raw === 'yes')
}

function isMutation(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
}

function denied(code: string, message: string, status = 403): NextResponse {
  return NextResponse.json({ error: { code, message, status } }, { status })
}

function hostDenied(host: string | null): NextResponse {
  return denied(
    'forbidden_host',
    `Host "${host ?? '(không có)'}" không đáng tin cậy. Chỉ chấp nhận loopback hoặc host khớp chính xác trong ALLOWED_ORIGINS.`,
  )
}

function originDenied(origin: string | null): NextResponse {
  return denied(
    'forbidden_origin',
    `Origin "${origin ?? '(không có)'}" không được phép. Origin phải trùng với Host và khớp chính xác (giao thức/host/cổng) với ALLOWED_ORIGINS hoặc loopback.`,
  )
}

/**
 * Host-only fence used by middleware and by `assertApiRequest`. Never reads
 * X-Forwarded-* headers.
 */
export function assertApiHost(req: Request): NextResponse | null {
  if (isTrustedHost(req.headers.get('host'))) return null
  return hostDenied(req.headers.get('host'))
}

/**
 * Full route policy. Mutating methods always require an exact trusted Origin,
 * even when the route is read-only (POST is used for id lists).
 */
export function assertApiRequest(req: Request, access: ApiAccess = 'read'): NextResponse | null {
  const host = req.headers.get('host')
  if (!isTrustedHost(host)) return hostDenied(host)

  const method = String(req.method || 'GET').toUpperCase()
  if (isMutation(method)) {
    const origin = req.headers.get('origin')
    if (!isTrustedOrigin(host, origin)) return originDenied(origin)
  }

  if (access === 'management-write' || access === 'privileged') {
    if (!managementWritesEnabled()) {
      return denied(
        'management_disabled',
        'Chế độ an toàn (quản lý chỉ đọc) đang bật. Không thực hiện thay đổi nào trên Hermes/LLM. ' +
          'Đặt rõ HVO_MANAGEMENT_MODE=write rồi khởi động lại để cho phép quản lý.',
      )
    }
    if (access === 'privileged' && !privilegedActionsEnabled()) {
      return denied(
        'privileged_disabled',
        'Thao tác đặc quyền/phá hủy đã tắt. Đặt rõ HVO_ALLOW_PRIVILEGED=1 (cùng với ' +
          'HVO_MANAGEMENT_MODE=write) rồi khởi động lại.',
      )
    }
  }

  return null
}

/** Documentation/help payload for API consumers. */
export function apiPolicySummary() {
  return {
    mode: managementMode(),
    privileged: privilegedActionsEnabled(),
    access: {
      read: 'Chỉ Host đáng tin cậy',
      'office-write': 'Host đáng tin cậy + Origin khớp chính xác (chỉ SQLite của văn phòng)',
      'management-write': 'Host đáng tin cậy + Origin khớp chính xác + HVO_MANAGEMENT_MODE=write',
      privileged: 'management-write + HVO_ALLOW_PRIVILEGED=1',
    },
    auth: 'KHÔNG CÓ — chỉ dùng cục bộ cho một người; không an toàn khi công khai nếu thiếu proxy xác thực',
  }
}
