import { NextRequest, NextResponse } from 'next/server'
import {
  commentOnTask,
  getTask,
  listRuns,
  promoteTask,
  releaseWorker,
  setTaskModel,
  taskLog,
  unblockTask,
} from '@/lib/hermes/kanban'
import { assertApiRequest } from '@/lib/api-policy'

export const dynamic = 'force-dynamic'

/**
 * HVO-05: "run selected card" is DISABLED.
 *
 * The old implementation called one board-wide `kanban dispatch --max 1` and
 * then checked whether the selected id happened to be the card it spawned. It
 * could run an unrelated ready card and spend tokens/cost on work nobody chose.
 * No exact-target native dispatch contract is supplied in this patch, so the
 * ambiguous operation is refused instead of pretending.
 */
const RUN_SELECTED_CARD_DISABLED = true
const RUN_SELECTED_CARD_DISABLED_REASON =
  'Nút "chạy thẻ này" ĐÃ TẮT: Hermes điều phối trên toàn bảng và có thể chạy thẻ khác. ' +
  'Chưa xác minh được khả năng nhắm đúng thẻ. Hãy chạy từ CLI/bảng với đích do bạn tự chọn.'

/**
 * One task: its run history and log tail, or an intervention.
 *
 * The `id` is checked against the board before anything else. A dynamic segment
 * matches ANY path, so without this check `/api/hermes/tasks/<anything>` answered
 * 200 with an empty payload — a misspelled or deleted task looked like a real task
 * that simply had no runs. A 404 is the honest answer.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  const { id } = await ctx.params
  try {
    const task = await getTask(id)
    if (!task) return notFound(id)
    const [runs, log] = await Promise.all([listRuns(id), taskLog(id)])
    return NextResponse.json({ taskId: id, task, runs, log })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'peek_failed', message: (err as Error).message, status: 502 } },
      { status: 502 },
    )
  }
}

/**
 * Desk intervention: steer (comment), reclaim (release the worker claim), run
 * (wake the dispatcher), promote (unblock), or set the worker's model.
 *
 * `run` and `promote` exist because the board has no runner of its own. A task
 * sits in `ready` until the gateway's dispatcher spawns a worker for it, so with
 * the gateway down a task is stranded with no visible reason and no way out from
 * the UI. `run` does one dispatch pass (the worker it spawns is detached and
 * outlives this request) and `promote` returns a blocked task to `ready`.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // The disabled `run` action is answered clearly in every mode; other actions
  // still require management-write.
  const ingress = assertApiRequest(req, 'office-write')
  if (ingress) return ingress
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action || '')
  if (action === 'run') {
    return NextResponse.json(
      {
        success: false,
        disabled: RUN_SELECTED_CARD_DISABLED,
        error: {
          code: 'run_disabled',
          message: RUN_SELECTED_CARD_DISABLED_REASON,
          status: 501,
        },
      },
      { status: 501 },
    )
  }
  const denied = assertApiRequest(req, 'management-write')
  if (denied) return denied
  try {
    // Same guard as GET: acting on a task that does not exist must say so rather
    // than report a downstream CLI error as a server fault.
    const task = await getTask(id)
    if (!task) return notFound(id)

    if (action === 'steer') {
      const message = String(body?.message || '').trim()
      if (!message) {
        return NextResponse.json(
          { error: { code: 'invalid_request', message: 'Bắt buộc nhập message', status: 400 } },
          { status: 400 },
        )
      }
      return NextResponse.json({ success: true, steered: await commentOnTask(id, message) })
    }
    if (action === 'cancel') {
      try {
        return NextResponse.json({ success: true, released: await releaseWorker(id) })
      } catch (err) {
        // The CLI refuses to reclaim a task that is not running. That is correct
        // behaviour, not a server fault, so report it as a conflict.
        const msg = (err as Error).message
        const notRunning = /cannot reclaim|not running|unknown id/i.test(msg)
        return NextResponse.json(
          {
            error: notRunning
              ? { code: 'not_running', message: 'Công việc này hiện không chạy.', status: 409 }
              : { code: 'action_failed', message: msg, status: 502 },
          },
          { status: notRunning ? 409 : 502 },
        )
      }
    }
    if (action === 'promote') {
      const reason = String(body?.message || '').trim() || 'dijalankan dari kantor'
      // `promote` refuses `scheduled`; `unblock` refuses nothing in that pair.
      const promoted =
        task.status === 'scheduled'
          ? await unblockTask(id, reason)
          : await promoteTask(id, reason)
      return NextResponse.json({ success: true, promoted })
    }
    if (action === 'set-model') {
      const model = body?.model == null ? null : String(body.model).trim() || null
      const provider = body?.provider == null ? null : String(body.provider).trim() || null
      return NextResponse.json({
        success: true,
        model: await setTaskModel(id, model, provider),
      })
    }
    return NextResponse.json(
      {
        error: {
          code: 'invalid_request',
          message: "action phải là 'steer', 'cancel', 'promote' hoặc 'set-model' ('run' đã bị tắt)",
          status: 400,
        },
      },
      { status: 400 },
    )
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'action_failed', message: (err as Error).message, status: 502 } },
      { status: 502 },
    )
  }
}

function notFound(id: string) {
  return NextResponse.json(
    { error: { code: 'not_found', message: `Công việc "${id}" không có trên bảng`, status: 404 } },
    { status: 404 },
  )
}
