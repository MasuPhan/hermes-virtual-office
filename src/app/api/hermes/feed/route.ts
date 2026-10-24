import { NextRequest, NextResponse } from 'next/server'
import { assertApiRequest } from '@/lib/api-policy'
import { createTask, defaultBoardSlug, listBoards, listProfiles } from '@/lib/hermes/kanban'
import { withBoardScope } from '@/lib/hermes/board-scope'
import { ackFeed, listFeed, pollFeed, recordAssignment, reportingAgents, unreadCount } from '@/lib/hermes/feed'
import { parseAssign } from '@/lib/hermes/mention'

export const dynamic = 'force-dynamic'

/**
 * /api/hermes/feed — "Phòng chung".
 *
 * GET              → { items, unread, reporting } after a (memoised) pass over every board.
 *                    `?summary=1` skips the item list: the office polls only the counts.
 * POST ack         → { action: 'ack', ids: number[] | 'all' } — office SQLite only.
 * POST assign      → { action: 'assign', text, board? } — "@agent việc …" becomes a card
 *                    on that board. A real Hermes write, so it needs management-write.
 */
export async function GET(req: NextRequest) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  await pollFeed()
  const summary = new URL(req.url).searchParams.get('summary') === '1'
  return NextResponse.json({
    ...(summary ? {} : { items: listFeed() }),
    unread: unreadCount(),
    reporting: reportingAgents(),
  })
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: { code: 'invalid_request', message, status } }, { status })
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return bad('body phải là JSON')

  if (body.action === 'ack') {
    const denied = assertApiRequest(req, 'office-write')
    if (denied) return denied
    const ids = body.ids === 'all' ? 'all' : Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n)) : null
    if (!ids) return bad('ids phải là mảng số hoặc "all"')
    return NextResponse.json({ acked: ackFeed(ids), unread: unreadCount(), reporting: reportingAgents() })
  }

  if (body.action === 'assign') {
    const denied = assertApiRequest(req, 'management-write')
    if (denied) return denied
    const text = typeof body.text === 'string' ? body.text.slice(0, 4000) : ''
    const parsed = parseAssign(text, await listProfiles())
    if (!parsed.ok) return bad(parsed.error)
    const boards = await listBoards().catch(() => [])
    const board = typeof body.board === 'string' && body.board ? body.board : defaultBoardSlug(boards)
    if (!boards.some((b) => b.slug === board)) return bad(`Không có bảng "${board}"`, 404)
    try {
      const task = await withBoardScope(board, () =>
        createTask({
          title: parsed.title,
          assignee: parsed.assignee,
          body: parsed.body || undefined,
          origin: { kind: 'manual', ref: 'office-room' },
        }),
      )
      const item = recordAssignment({ agent: parsed.assignee, board, taskId: task.id, title: task.title, text: parsed.body })
      return NextResponse.json({ task: { ...task, board }, item }, { status: 201 })
    } catch (err) {
      return NextResponse.json({ error: { code: 'dispatch_failed', message: (err as Error).message, status: 502 } }, { status: 502 })
    }
  }

  return bad('action phải là "ack" hoặc "assign"')
}
