import { NextRequest, NextResponse } from 'next/server'
import { assertApiRequest } from '@/lib/api-policy'
import { inRequestBoard } from '@/lib/hermes/board-request'
import { beginAudit, denyAudit } from '@/lib/hermes/audit'
import { envBoard, scopedBoard } from '@/lib/hermes/board-scope'
import { _resetBoardCachesForTest as resetBoardCaches } from '@/lib/hermes/kanban'
import {
  TaskArchiveError,
  archiveCards,
  deleteCards,
  deleteConfirmToken,
  validateIds,
  type IdOutcome,
} from '@/lib/hermes/task-archive'

export const dynamic = 'force-dynamic'

/**
 * POST /api/hermes/tasks/archive?board=<slug>
 *   { action: 'archive', ids: [...] }                         management-write
 *   { action: 'delete',  ids: [...], confirm: 'delete:<ids>' } privileged (hard delete)
 *   { action: 'unarchive' }                                   501: the Hermes CLI has no verb
 *
 * Every call is audited (intent first, then result) with its board and ids; refusals by
 * the write guard are audited too. Running cards are never archived or deleted.
 */
async function handlePOST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; ids?: unknown; confirm?: unknown }
  const action = String(body?.action ?? '')
  if (action === 'unarchive') {
    return err(
      'unarchive_unsupported',
      'Hermes CLI chưa có lệnh khôi phục thẻ đã lưu trữ (chỉ có archive và archive --rm). Văn phòng không ghi thẳng vào CSDL của Hermes.',
      501,
    )
  }
  if (action !== 'archive' && action !== 'delete') {
    return err('invalid_request', "action phải là 'archive' hoặc 'delete'", 400)
  }

  let ids: string[]
  try {
    ids = validateIds(body?.ids)
  } catch (e) {
    const x = e as TaskArchiveError
    return err(x.code, x.message, x.status)
  }

  const kind = action === 'delete' ? 'kanban-delete' : 'kanban-archive'
  // The audit always names a board: the request's, else the env default, else the CLI's current one.
  const board = scopedBoard() || envBoard() || '(cli-current)'
  const denied = assertApiRequest(req, action === 'delete' ? 'privileged' : 'management-write')
  if (denied) {
    denyAudit({ at: new Date().toISOString(), action: kind, board, taskId: ids.join(','), effect: '' }, `guard ${denied.status}`)
    return denied
  }
  if (action === 'delete' && body?.confirm !== deleteConfirmToken(ids)) {
    return err('confirm_required', 'Xóa vĩnh viễn cần xác nhận rõ ràng cho đúng các công việc này', 400)
  }

  const audit = beginAudit({
    at: new Date().toISOString(),
    action: kind,
    board,
    taskId: ids.join(','),
    effect: action === 'delete' ? `Xóa vĩnh viễn ${ids.length} công việc` : `Lưu trữ ${ids.length} công việc`,
  })
  try {
    const results: IdOutcome[] = action === 'delete' ? await deleteCards(ids) : await archiveCards(ids)
    resetBoardCaches()
    const done = results.filter((r) => r.ok).map((r) => r.id)
    const failed = results.filter((r) => !r.ok)
    audit.finish(
      `${action} ok=[${done.join(',')}]` + (failed.length ? ` failed=[${failed.map((f) => `${f.id}:${f.code}`).join(',')}]` : ''),
      failed.length === 0,
    )
    return NextResponse.json({ ok: failed.length === 0, action, results }, { status: done.length || !failed.length ? 200 : 409 })
  } catch (e) {
    audit.finish(`LỖI: ${(e as Error).message}`, false)
    return err('action_failed', (e as Error).message, 502)
  }
}

function err(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message, status } }, { status })
}

export async function POST(req: NextRequest) {
  return inRequestBoard(req, () => handlePOST(req))
}
