import { NextRequest, NextResponse } from 'next/server'
import { allBoardTasks, listAgents, listAssignees, listBoards, listProfiles, profileModel, readGeneration } from '@/lib/hermes/kanban'
import { blockedAssigneesFor } from '@/lib/hermes/approvals'
import { hiddenNames } from '@/lib/hermes/office-membership'
import { assertApiRequest } from '@/lib/api-policy'
import { buildTeam, type Team } from '@/lib/hermes/team'
import { swr } from '@/lib/swr'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hermes/team — read-only: every profile with its cards on ALL boards.
 *
 * Cost: one `list` per board + one `config get model` per profile, each a CLI
 * process (~1.4 s). They run in parallel; the answer is fresh for 15 s and then
 * served instantly (stale, up to 2 min) while one refresh runs in the background,
 * so opening the page never waits on the CLI after the first time.
 */
const TTL_MS = 15_000
const MAX_STALE_MS = 2 * 60_000

const readTeam = swr(
  async (): Promise<Team & { readAt: string }> => {
    const [boards, profiles, assignees, tasks] = await Promise.all([listBoards(), listProfiles(), listAssignees(), allBoardTasks()])
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
    return { ...team, readAt: new Date().toISOString() }
  },
  // A write (answer, unblock, assign) throws the stored answer away: the roster must not keep
  // counting a card the operator has just unblocked.
  { freshMs: TTL_MS, maxStaleMs: MAX_STALE_MS, version: readGeneration },
)

export async function GET(req: NextRequest) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  try {
    return NextResponse.json(await readTeam())
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 })
  }
}
