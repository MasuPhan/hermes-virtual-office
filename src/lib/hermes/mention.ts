/**
 * "@agent việc …" parsing for Phòng chung. Pure and dependency-free, so the browser
 * can preview an assignment with exactly the rule the server applies.
 */

export type ParsedAssign = { ok: true; assignee: string; title: string; body: string } | { ok: false; error: string }

/** `@name` or full-width `＠name`; names are Hermes profile names (lowercase, digits, - _). */
const MENTION = /[@＠]([a-z0-9][a-z0-9_-]{0,63})/gi

/**
 * "@developer viết API thanh toán\nchi tiết…" → assignee + title + body. Pure.
 *
 * Exactly one known profile must be mentioned: a card has one assignee, and guessing
 * which of two names was meant would hand work to the wrong person. The title is the
 * first line without the mention (cut at 120 chars); the full text becomes the body
 * when it says more than the title.
 */
export function parseAssign(text: string, profiles: string[]): ParsedAssign {
  const known = new Map(profiles.map((p) => [p.toLowerCase(), p]))
  const names = [...new Set([...text.matchAll(MENTION)].map((m) => m[1].toLowerCase()))]
  if (!names.length) return { ok: false, error: 'Gõ @tên để giao việc, ví dụ: @developer viết API thanh toán' }
  const unknown = names.filter((n) => !known.has(n))
  if (unknown.length) return { ok: false, error: `Không có agent tên ${unknown.map((n) => '@' + n).join(', ')}` }
  if (names.length > 1) return { ok: false, error: 'Mỗi lần chỉ giao cho một agent' }
  const assignee = known.get(names[0])!
  const rest = text.replace(MENTION, ' ').replace(/[ \t]+/g, ' ').trim()
  const lines = rest.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return { ok: false, error: `Thiếu nội dung việc cho @${assignee}` }
  const first = lines[0].replace(/^[:,\-–—\s]+/, '')
  const title = first.length > 120 ? `${first.slice(0, 117).trimEnd()}…` : first
  const body = lines.join('\n') !== title ? lines.join('\n') : ''
  return { ok: true, assignee, title, body }
}
