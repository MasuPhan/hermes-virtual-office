import { NextRequest, NextResponse } from 'next/server'
import { listAgents, listAssignees, listBoards, listProfiles, listTasks, profileModel } from '@/lib/hermes/kanban'
import { blockedAssigneesFor } from '@/lib/hermes/approvals'
import { hiddenNames } from '@/lib/hermes/office-membership'
import { assertApiRequest } from '@/lib/api-policy'
import { buildTeam, type Team } from '@/lib/hermes/team'
import type { Task } from '@/types/hermes'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hermes/team — read-only: every profile with its cards on ALL boards.
 *
 * Cost: one `list` per board + one `config get model` per profile, each a CLI
 * process (~1.4 s). They run in parallel and the whole answer is memoised for
 * 15 s, so a page left open polls the CLI at most four times a minute.
 */
const TTL_MS = 15_000
let memo: { at: number; data: Team & { readAt: string } } | null = null

export async function GET(req: NextRequest) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  if (memo && Date.now() - memo.at < TTL_MS) return NextResponse.json(memo.data)
  try {
    const [boards, profiles, assignees] = await Promise.all([listBoards(), listProfiles(), listAssignees()])
    const perBoard = await Promise.all(boards.map((b) => listTasks({ board: b.slug }).catch(() => [] as Task[])))
    const tasks = perBoard.flat()
    const busy = tasks.filter((t) => t.status === 'running' || t.status === 'review')
    const [agents, models] = await Promise.all([
      blockedAssigneesFor(busy).then((blocked) => listAgents(busy, assignees, blocked)),
      Promise.all(profiles.map(async (p) => [p, (await profileModel(p)).model] as const)),
    ])
    const team = buildTeam({
      profiles,
      agents,
      tasks,
      models: new Map(models),
      hidden: new Set(hiddenNames()),
      boards: boards.length,
    })
    const data = { ...team, readAt: new Date().toISOString() }
    memo = { at: Date.now(), data }
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 })
  }
}
