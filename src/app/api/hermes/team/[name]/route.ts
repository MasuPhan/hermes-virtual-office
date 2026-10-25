import { NextRequest, NextResponse } from 'next/server'
import { assertApiRequest } from '@/lib/api-policy'
import { getTaskDetail, listBoards, listTasks, readGeneration } from '@/lib/hermes/kanban'
import { listFeed } from '@/lib/hermes/feed'
import { buildBrief, detailIds, type AgentBrief } from '@/lib/hermes/agent-brief'
import { validateAssigneeName } from '@/lib/hermes/profile-name'
import { swr } from '@/lib/swr'
import type { Task } from '@/types/hermes'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hermes/team/<name> — read-only: what one agent is waiting on you for, what it just
 * finished, what is queued (see lib/hermes/agent-brief.ts).
 *
 * Cost: the boards' `list` (shared with every other poll through the CLI read cache) plus one
 * `show` per blocked/review card and the last two done — all in parallel. A click is answered
 * from the last result when it is under 8 s old; an older one is served at once while one
 * refresh runs, and ANY write to the board (comment, unblock, assign) throws it away, so the
 * panel never shows a state the operator has already changed.
 */
const readers = new Map<string, () => Promise<AgentBrief>>()

function readerFor(name: string): () => Promise<AgentBrief> {
  let r = readers.get(name)
  if (!r) {
    r = swr(
      async () => {
        const boards = await listBoards()
        const perBoard = await Promise.all(boards.map((b) => listTasks({ board: b.slug }).catch(() => [] as Task[])))
        const tasks = perBoard.flat()
        const wanted = detailIds(name, tasks)
        const details = new Map(
          await Promise.all(
            wanted.map(async (w) => [w.id, await getTaskDetail(w.id, w.board || undefined).catch(() => null)] as const),
          ),
        )
        return buildBrief({ name, tasks, details, feed: listFeed(200) })
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
