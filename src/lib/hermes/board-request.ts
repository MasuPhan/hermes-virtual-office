import { NextResponse } from 'next/server'
import { assertApiHost } from '@/lib/api-policy'
import { BoardError, envBoard, isValidBoardSlug, withBoardScope } from './board-scope'
import { listBoards } from './kanban'

/**
 * Read `?board=<slug>` from a kanban request and check it.
 *
 * - absent / empty      → '' (office default: HERMES_KANBAN_BOARD or the CLI's current board)
 * - not a valid slug    → 400 invalid_board (never reaches argv)
 * - not an active board → 404 unknown_board (checked against `boards list`, memoised 15 s)
 */
export async function resolveRequestBoard(req: Request): Promise<string> {
  // Hand-built requests in tests (and some proxies) may carry a relative or missing url.
  let raw: string | null = null
  try {
    raw = new URL(req.url || '/', 'http://localhost').searchParams.get('board')
  } catch {
    raw = null
  }
  if (raw == null || raw === '') return ''
  if (!isValidBoardSlug(raw)) {
    throw new BoardError('invalid_board', `Tên bảng không hợp lệ: ${JSON.stringify(String(raw).slice(0, 80))}`, 400)
  }
  if (raw === envBoard()) return raw
  let boards
  try {
    boards = await listBoards()
  } catch (err) {
    throw new BoardError('boards_unavailable', `Không đọc được danh sách bảng: ${(err as Error).message}`, 503)
  }
  if (!boards.some((b) => b.slug === raw)) {
    throw new BoardError('unknown_board', `Không có bảng "${raw}"`, 404)
  }
  return raw
}

/**
 * Wrap a kanban route handler: host fence first, then the board check, then the handler
 * runs inside `withBoardScope`, so every CLI call it makes carries `--board <slug>` and
 * every audit line it writes records the board.
 */
export async function inRequestBoard(req: Request, handler: () => Promise<Response>): Promise<Response> {
  const host = assertApiHost(req)
  if (host) return host
  let board: string
  try {
    board = await resolveRequestBoard(req)
  } catch (err) {
    if (err instanceof BoardError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, status: err.status } }, { status: err.status })
    }
    throw err
  }
  return withBoardScope(board, handler)
}
