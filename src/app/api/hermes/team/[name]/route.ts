import { NextRequest, NextResponse } from 'next/server'
import { assertApiRequest } from '@/lib/api-policy'
import { allBoardTasks, getTaskDetail, readGeneration, type TaskDetail } from '@/lib/hermes/kanban'
import { listFeed } from '@/lib/hermes/feed'
import { buildBrief, detailIds, type AgentBrief } from '@/lib/hermes/agent-brief'
import { validateAssigneeName } from '@/lib/hermes/profile-name'
import { swr } from '@/lib/swr'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hermes/team/<name> — read-only: what one agent is waiting on you for, what it just
 * finished, what is queued (see lib/hermes/agent-brief.ts).
 *
 * Cost: the all-boards snapshot (kept warm by the roster's own poll, see `allBoardTasks`) plus
 * one `show` per blocked/review card and the last two done, in parallel and remembered per
 * card (`detailOf`). A click is answered from the last result when it is under 8 s old; an
 * older one is served at once while one refresh runs, and ANY write to the board (comment,
 * unblock, assign) throws it away, so the panel never shows a state the operator has changed.
 */
const readers = new Map<string, () => Promise<AgentBrief>>()

/**
 * `show` of one card: a blocked card's reason and a finished card's summary do not change
 * between polls, and each read is a Python process. Kept 5 min, per card and status, and
 * dropped by any write. A card that gets blocked again changes status first, so it is re-read.
 */
const DETAIL_TTL_MS = 5 * 60_000
const details = new Map<string, { at: number; gen: number; d: TaskDetail | null }>()

async function detailOf(id: string, board: string, status: string): Promise<TaskDetail | null> {
  const key = `${board}:${id}:${status}`
  const gen = readGeneration()
  const hit = details.get(key)
  if (hit && hit.gen === gen && Date.now() - hit.at < DETAIL_TTL_MS) return hit.d
  const d = await getTaskDetail(id, board || undefined).catch(() => null)
  if (d) {
    if (details.size > 400) details.clear()
    details.set(key, { at: Date.now(), gen, d })
  }
  return d
}

function readerFor(name: string): () => Promise<AgentBrief> {
  let r = readers.get(name)
  if (!r) {
    r = swr(
      async () => {
        const tasks = await allBoardTasks()
        const status = new Map(tasks.map((t) => [t.id, t.status]))
        const wanted = detailIds(name, tasks)
        const read = new Map(
          await Promise.all(wanted.map(async (w) => [w.id, await detailOf(w.id, w.board, status.get(w.id) ?? '')] as const)),
        )
        return buildBrief({ name, tasks, details: read, feed: listFeed(200) })
      },
      { freshMs: 8_000, maxStaleMs: 60_000, version: readGeneration },
    )
    readers.set(name, r)
  }
  return r
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  let name: string
  try {
    name = validateAssigneeName((await ctx.params).name)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
  try {
    return NextResponse.json(await readerFor(name)())
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 })
  }
}
