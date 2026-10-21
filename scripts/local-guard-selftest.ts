/**
 * Write-guard self-test.
 *
 * This guard is the difference between "the buttons work" and "nothing you click
 * does anything", so it is tested against BOTH failure modes:
 *
 *   - too strict: a legitimate origin is refused, so every write 403s from the
 *     browser while reads keep working.
 *   - too loose: a foreign origin is accepted, which is a CSRF hole.
 *
 * The guard now checks exact scheme/host/port for configured origins. A full
 * `https://office.example.com` entry must work; an http origin for that host
 * must not, and an unconfigured https host must not.
 */
import { localOriginAllowed } from '../src/lib/local-guard'

let failed = 0
const check = (label: string, got: boolean, want: boolean) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}  -> ${got}${ok ? '' : ` (harap ${want})`}`)
}

// `ALLOWED_ORIGINS` is read at call time. Full origins are exact; bare entries
// are plain http (a bare host without a port is legacy: same host, any port).
process.env.ALLOWED_ORIGINS =
  '203.0.113.10:3300,office.example.com,https://secure.example.com'

console.log('=== HARUS DITERIMA (kalau tidak, tombol mati) ===')
const valid: [string, string][] = [
  ['localhost:3000', 'http://localhost:3000'],
  ['127.0.0.1:3000', 'http://127.0.0.1:3000'],
  ['[::1]:3000', 'http://[::1]:3000'],
  // loopback over https is still loopback: the old blanket HTTPS rejection was
  // a compatibility bug, not a security feature.
  ['localhost:3000', 'https://localhost:3000'],
  // the public address the office is actually opened at
  ['203.0.113.10:3300', 'http://203.0.113.10:3300'],
  // a named host from the list, with and without a port (legacy bare entry)
  ['office.example.com:3300', 'http://office.example.com:3300'],
  ['office.example.com', 'http://office.example.com'],
  // explicitly configured HTTPS origin: exact scheme/host/port
  ['secure.example.com', 'https://secure.example.com'],
  ['secure.example.com:443', 'https://secure.example.com'],
]
for (const [host, origin] of valid) {
  check(`${origin}`, localOriginAllowed(host, origin), true)
}

console.log('\n=== HARUS DITOLAK (kalau tidak, ini lubang CSRF) ===')
const invalid: [string | null, string | null][] = [
  // cross-site: Origin names somebody else
  ['localhost:3000', 'http://evil.test'],
  ['203.0.113.10:3300', 'http://evil.test'],
  // a host we do not trust, even though host and origin agree
  ['office.example:3000', 'http://office.example:3000'],
  ['198.51.100.7:3300', 'http://198.51.100.7:3300'],
  // scheme mismatch: bare entry is http-only
  ['203.0.113.10:3300', 'https://203.0.113.10:3300'],
  ['secure.example.com', 'http://secure.example.com'],
  // wrong port for an explicitly configured https origin
  ['secure.example.com:8443', 'https://secure.example.com:8443'],
  // missing headers (curl, a cross-site form post, a server-to-server call)
  ['localhost:3000', null],
  [null, 'http://localhost:3000'],
  [null, null],
  // a subdomain is NOT the same host
  ['localhost:3000', 'http://evil.localhost:3000'],
  // a host that merely CONTAINS a trusted one
  ['not203.0.113.10:3300', 'http://not203.0.113.10:3300'],
]
for (const [host, origin] of invalid) {
  check(`${origin ?? '(tanpa origin)'} @ host ${host ?? '(tanpa host)'}`, localOriginAllowed(host, origin), false)
}

console.log('\n=== TANPA ALLOWED_ORIGINS (deploy yang belum dikonfigurasi) ===')
const noConfigChecks: boolean[] = []
{
  const saved = process.env.ALLOWED_ORIGINS
  delete process.env.ALLOWED_ORIGINS
  // loopback must still work: the server-side tooling and the local dev loop
  const loopback = localOriginAllowed('127.0.0.1:3300', 'http://127.0.0.1:3300')
  noConfigChecks.push(loopback)
  check('localhost masih boleh', loopback, true)
  // the public address must NOT be silently allowed — an operator has to opt in
  const pub = localOriginAllowed('203.0.113.10:3300', 'http://203.0.113.10:3300')
  noConfigChecks.push(pub)
  check('IP publik ditolak (harus diisi di ALLOWED_ORIGINS)', pub, false)
  process.env.ALLOWED_ORIGINS = saved
}

console.log('\n=== RINGKASAN ===')
const total = valid.length + invalid.length + noConfigChecks.length
if (failed) {
  console.log(`  ${failed} dari ${total} GAGAL`)
  process.exit(1)
}
console.log(`  ${total}/${total} write-guard checks passed`)
