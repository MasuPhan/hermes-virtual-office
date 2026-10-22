import { NextResponse, type NextRequest } from 'next/server'
import { assertApiHost } from '@/lib/api-policy'

/**
 * Common API ingress fence for EVERY method, including GET.
 *
 * Next middleware runs before route handlers, so no API route can be read via an
 * attacker-controlled Host. Route handlers still call `assertApiRequest` for
 * Origin + safe-mode policy; this is the belt-and-braces outer layer.
 */
export function middleware(req: NextRequest) {
  const denied = assertApiHost(req)
  if (denied) return denied
  return NextResponse.next()
}

export const config = {
  matcher: ['/api/:path*'],
}
