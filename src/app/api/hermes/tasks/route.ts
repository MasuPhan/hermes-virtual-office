import { NextRequest, NextResponse } from 'next/server'
import { busyOnOtherBoards, createTask, listAgents, listAssignees, listTasks } from '@/lib/hermes/kanban'
import { scopedBoard } from '@/lib/hermes/board-scope'
import { visible } from '@/lib/hermes/office-membership'
import { blockedAssigneesFor } from '@/lib/hermes/approvals'
import type { TaskOrigin } from '@/types/hermes'
import { assertApiRequest } from '@/lib/api-policy'
import { validateAssigneeName } from '@/lib/hermes/profile-name'
import { inRequestBoard } from '@/lib/hermes/board-request'

export const dynamic = 'force-dynamic'

/** The board: tasks plus the agents staffing them. */
async function handleGET(req: NextRequest) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  try {
    // `--archived` is inclusive, so this is the live board PLUS the archive: the
    // 2D view has an ARSIP column that stayed permanently empty without it.
    // The two CLI reads are independent, so they run together — sequentially
    // they cost ~2.8 s per poll on a small machine.
    // The other boards' running cards (all-board avatar status) need no row of THIS board, so
    // they start now too: three independent CLI rounds in parallel instead of two in a row.
    const board = scopedBoard() || ''
    const [tasks, assignees, elsewhere] = await Promise.all([
      listTasks({ includeArchived: true }),
      listAssignees(),
      busyOnOtherBoards(board),
    ])
    // Apply the hide list: a hidden profile is absent from the office but its
    // tasks stay on the board, so the work is never hidden, only the avatar.
    // Ini yang memberi makan avatar: agent yang task aktifnya menunggu manusia harus tampil
    // 'blocked' DI SINI, bukan hanya di menu spawn.
    //
    // Avatars aggregate busy tasks across ALL boards (Masu's decision, Batch A): a profile
    // working on another project's board must not look idle because that board is not on
    // screen. The selected board's rows are reused; other boards cost one memoised `list`.
    const busy = [...tasks.filter((t) => t.status === 'running' || t.status === 'review'), ...elsewhere]
    const agents = visible(await listAgents(busy, assignees, await blockedAssigneesFor(busy)))
    return NextResponse.json({ tasks, agents, board: board || null })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'hermes_unavailable', message: (err as Error).message, status: 503 } },
      { status: 503 },
    )
  }
}

/**
 * Create one or more tasks.
 *
 * ONE endpoint for both shapes, because they are the same operation:
 *
 *   { title, assignee, ... }        -> a single task
 *   { origin, items: [...] }        -> several, all sharing an origin
 *
 * These used to be two routes (`tasks/create` and `tasks/from-items`) which
 * duplicated the whole create path, the origin validation and the partial-failure
 * reporting. Two copies of the same logic drift; one cannot.
 *
 * `origin` records where the work came from so the board can show it and the source
 * panel can list what it produced. It is written to `created_by` as a marker.
 */
async function handlePOST(req: NextRequest) {
  const denied = assertApiRequest(req, 'management-write')
  if (denied) return denied
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return bad('body phải là JSON')
  }

  const origin = readOrigin((body as Record<string, unknown>).origin)

  // ---- batch shape: { items: [...] } ----
  const items = (body as Record<string, unknown>).items
  if (Array.isArray(items)) {
    if (!origin) return bad('origin.kind không xác định')
    if (!items.length) return bad('Không có mục nào')
    return createMany(items, origin)
  }

  // ---- single shape: { title, assignee } ----
  const title = typeof (body as { title?: unknown }).title === 'string' ? (body as { title: string }).title.trim() : ''
  const assignee =
    typeof (body as { assignee?: unknown }).assignee === 'string'
      ? (body as { assignee: string }).assignee.trim()
      : ''
  if (!title) return bad('Bắt buộc nhập title')
  if (!assignee) return bad('Bắt buộc chọn assignee')
  let safeAssignee: string
  try {
    safeAssignee = validateAssigneeName(assignee)
  } catch (err) {
    return bad((err as Error).message)
  }

  const b = body as Record<string, unknown>
  try {
    const task = await createTask({
      title: title.slice(0, 300),
      assignee: safeAssignee,
      body: typeof b.body === 'string' ? b.body : undefined,
      priority: Number.isFinite(Number(b.priority)) ? Number(b.priority) : undefined,
      origin,
    })
    return NextResponse.json({ success: true, task }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'dispatch_failed', message: (err as Error).message, status: 502 } },
      { status: 502 },
    )
  }
}

/** Accept only origins the UI may set, so `created_by` stays parseable. */
function readOrigin(raw: unknown): TaskOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const kind = String(o.kind ?? '')
  if (kind !== 'meeting' && kind !== 'cron' && kind !== 'agent' && kind !== 'manual') {
    return undefined
  }
  const ref = typeof o.ref === 'string' && o.ref.trim() ? o.ref.trim().slice(0, 120) : undefined
  return { kind, ref }
}

function bad(message: string) {
  return NextResponse.json(
    { error: { code: 'invalid_request', message, status: 400 } },
    { status: 400 },
  )
}

/**
 * Create many tasks under one origin.
 *
 * Partial success is the normal case — one row with no assignee must not lose the
 * others — so the reply reports both lists and the caller decides what to say.
 */
async function createMany(raw: unknown[], origin: TaskOrigin) {
  const created: { id: string; title: string; assignee: string }[] = []
  const failed: { title: string; error: string }[] = []

  // Bounded: a runaway source must not create hundreds of tasks in one request.
  for (const it of raw.slice(0, 25)) {
    const row = (it ?? {}) as Record<string, unknown>
    const title = String(row.title ?? row.text ?? '').trim().slice(0, 300)
    let assignee: string
    try {
      assignee = validateAssigneeName(String(row.assignee ?? '').trim())
    } catch (err) {
      if (title) failed.push({ title, error: (err as Error).message })
      continue
    }
    if (!title) continue
    if (!assignee) {
      failed.push({ title, error: 'Chưa chọn người phụ trách' })
      continue
    }
    try {
      const task = await createTask({
        title,
        assignee,
        body: typeof row.body === 'string' && row.body.trim() ? row.body : undefined,
        priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : undefined,
        origin,
      })
      created.push({ id: task.id, title: task.title, assignee })
    } catch (err) {
      failed.push({ title, error: (err as Error).message })
    }
  }

  return NextResponse.json(
    { success: created.length > 0, created, failed, origin },
    { status: created.length ? 201 : 502 },
  )
}

/* Board scope: `?board=<slug>` → every CLI call in the handler gets `--board <slug>`. */
export async function GET(req: NextRequest) {
  return inRequestBoard(req, () => handleGET(req))
}

export async function POST(req: NextRequest) {
  return inRequestBoard(req, () => handlePOST(req))
}
