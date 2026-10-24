import type { Agent, AgentDivision, AgentRole, AgentStatus, Task, TaskStatus } from '@/types/hermes'

/**
 * "Đội AI" (/team): every Hermes profile with its work across ALL boards.
 *
 * Pure: the route reads the CLI, this only folds the rows, so the numbers are
 * testable without Hermes. Measured on a real install (v0.21):
 * - `created_by` holds the creating PROFILE's name when an agent made the card
 *   (`default` → `developer` …); people show up as `user`, `dashboard`, `desktop`.
 * - unassigned cards wait in `triage` until a specifier picks them up.
 * - assignees can outlive their profile (a deleted agent still holds cards).
 */

export type TeamMember = {
  name: string
  displayName: string
  role: AgentRole | null
  division: AgentDivision | null
  domains: string[]
  soulExists: boolean
  model: string | null
  /** Hidden from the 3D office (still a profile; the team page lists it anyway). */
  hidden: boolean
  /** Office status, except an idle agent holding a blocked card reads `blocked`. */
  status: AgentStatus
  currentTask: { id: string; title: string; board?: string } | null
  /** Live (non-archived) cards by status, summed over every board. */
  counts: Partial<Record<TaskStatus, number>>
  /** Live cards not yet done. */
  open: number
  done: number
  /** Boards where this agent holds open cards. */
  boards: { slug: string; open: number }[]
  /** Live cards this profile created for ANOTHER profile. */
  delegatedOut: number
  /** Live cards another profile created for this one. */
  delegatedIn: number
  /** Latest created/updated/completed time of its cards, ISO. */
  lastActivity: string | null
}

export type TeamSummary = {
  agents: number
  working: number
  blocked: number
  idle: number
  openTasks: number
  /** Cards in triage with nobody assigned — waiting for Hermes to spec them. */
  triageUnassigned: number
  boards: number
  /** Assignees with open cards but no profile on disk (deleted agents). */
  orphans: { name: string; open: number }[]
}

export type Team = { members: TeamMember[]; summary: TeamSummary }

const DIVISION_ORDER: (AgentDivision | null)[] = ['exec', 'tech', 'growth', 'content', null]

function isLive(t: Task): boolean {
  return t.status !== 'archived'
}

/** The profile that created a card, or null when a person (or unknown tool) did. */
export function creatorProfile(t: Task, profiles: ReadonlySet<string>): string | null {
  const o = t.origin
  if (!o) return null
  if (o.kind === 'agent' && o.ref && profiles.has(o.ref)) return o.ref
  const raw = (o.raw || '').trim()
  return profiles.has(raw) ? raw : null
}

function later(a: string | null, b?: string): string | null {
  if (!b) return a
  return !a || b > a ? b : a
}

export function buildTeam(input: {
  profiles: string[]
  agents: Agent[]
  tasks: Task[]
  models: Map<string, string | null>
  hidden: ReadonlySet<string>
  boards: number
}): Team {
  const profiles = new Set(input.profiles)
  const meta = new Map(input.agents.map((a) => [a.name, a]))
  const live = input.tasks.filter(isLive)

  const members: TeamMember[] = [...profiles].map((name) => {
    const a = meta.get(name)
    const mine = live.filter((t) => t.assignee === name)
    const counts: Partial<Record<TaskStatus, number>> = {}
    const perBoard = new Map<string, number>()
    let lastActivity: string | null = null
    for (const t of mine) {
      counts[t.status] = (counts[t.status] ?? 0) + 1
      if (t.status !== 'done') perBoard.set(t.board ?? '', (perBoard.get(t.board ?? '') ?? 0) + 1)
      lastActivity = later(later(later(lastActivity, t.createdAt), t.updatedAt), t.completedAt)
    }
    const done = counts.done ?? 0
    const current = a?.currentTaskId
      ? { id: a.currentTaskId, title: a.currentTaskTitle ?? a.currentTaskId, ...(a.currentTaskBoard ? { board: a.currentTaskBoard } : {}) }
      : null
    return {
      name,
      displayName: a?.displayName ?? name,
      role: a?.role ?? null,
      division: a?.division ?? null,
      domains: a?.domains ?? [],
      soulExists: a?.soulExists ?? false,
      model: input.models.get(name) ?? a?.model ?? null,
      hidden: input.hidden.has(name),
      // The office status only looks at the card in hand; an otherwise idle agent
      // still holding a blocked card needs a person, so it reads as blocked here.
      status: (a?.status ?? 'idle') === 'idle' && counts.blocked ? 'blocked' : (a?.status ?? 'idle'),
      currentTask: current,
      counts,
      open: mine.length - done,
      done,
      boards: [...perBoard].map(([slug, open]) => ({ slug, open })).sort((x, y) => y.open - x.open || x.slug.localeCompare(y.slug)),
      delegatedOut: live.filter((t) => t.assignee && t.assignee !== name && creatorProfile(t, profiles) === name).length,
      delegatedIn: mine.filter((t) => {
        const c = creatorProfile(t, profiles)
        return c !== null && c !== name
      }).length,
      lastActivity,
    }
  })

  members.sort(
    (x, y) => DIVISION_ORDER.indexOf(x.division) - DIVISION_ORDER.indexOf(y.division) || x.name.localeCompare(y.name),
  )

  const orphanOpen = new Map<string, number>()
  for (const t of live) {
    if (t.assignee && !profiles.has(t.assignee) && t.status !== 'done') {
      orphanOpen.set(t.assignee, (orphanOpen.get(t.assignee) ?? 0) + 1)
    }
  }

  return {
    members,
    summary: {
      agents: members.length,
      working: members.filter((m) => m.status === 'working' || m.status === 'review').length,
      blocked: members.filter((m) => m.status === 'blocked').length,
      idle: members.filter((m) => m.status === 'idle').length,
      openTasks: live.filter((t) => t.status !== 'done').length,
      triageUnassigned: live.filter((t) => t.status === 'triage' && !t.assignee).length,
      boards: input.boards,
      orphans: [...orphanOpen].map(([name, open]) => ({ name, open })).sort((x, y) => x.name.localeCompare(y.name)),
    },
  }
}
