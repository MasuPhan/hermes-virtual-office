import { NextRequest, NextResponse } from 'next/server'
import { assertApiRequest, managementWritesEnabled, privilegedActionsEnabled } from '@/lib/api-policy'
import { defaultBoardSlug, listBoards } from '@/lib/hermes/kanban'
import { envBoard } from '@/lib/hermes/board-scope'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hermes/boards — the Hermes kanban boards, read-only.
 *
 * `hermes kanban boards list --json`, memoised 15 s, with per-status counts (free: the CLI
 * computes them). Filesystem paths from the CLI are dropped. `defaultBoard` is what a
 * request without `?board=` reads. There is deliberately no write here: creating,
 * renaming or switching boards is not an office action (and `boards switch` is never run).
 */
export async function GET(req: NextRequest) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  try {
    const boards = await listBoards()
    // `writes`: which Kanban buttons the UI may enable (archive = management-write,
    // delete = privileged). The server still enforces both on every write.
    const writes = { management: managementWritesEnabled(), privileged: privilegedActionsEnabled() }
    return NextResponse.json({ boards, defaultBoard: defaultBoardSlug(boards), envBoard: envBoard() || null, writes })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'boards_unavailable', message: (err as Error).message, status: 503 } },
      { status: 503 },
    )
  }
}
