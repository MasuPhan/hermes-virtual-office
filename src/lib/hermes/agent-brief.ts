import type { Task } from '@/types/hermes'
import type { TaskDetail } from './kanban'
import type { FeedItem } from './feed'

/**
 * One agent's situation for the panel that opens when you click it in the team roster:
 * what it is waiting on you for (the blocked cards with the reason Hermes recorded), what
 * it just finished, and what is queued — so a click lands on the next decision, not on a
 * card of labels.
 *
 * Pure: the route reads the CLI, this only folds rows (Hermes shapes measured on a real
 * v0.22 install: a `blocked` event carries `payload.reason` and, usually, `payload.kind`
 * = `needs_input` | `dependency`; `created_at` is unix seconds).
 */

export type BlockKind = 'needs_input' | 'dependency' | 'other'

export type BriefCard = {
  id: string
  board: string
  title: string
  status: Task['status']
  createdAt?: string
  updatedAt?: string
  /** blocked cards: when the last `blocked` event happened. */
  blockedAt?: string
  kind?: BlockKind
  /** blocked cards: why, as recorded by Hermes. */
  reason?: string
}

export type BriefDone = { id: string; board: string; title: string; completedAt?: string; summary?: string }

export type AgentBrief = {
  name: string
  /** Open cards, the most urgent first: blocked (oldest first), review, running, then the queue. */
  cards: BriefCard[]
  /** Last finished cards, newest first. */
  recentDone: BriefDone[]
  /** Unread done/blocked reports of this agent from the room feed. */
  reports: FeedItem[]
  readAt: string
}

const REASON_MAX = 1500
const SUMMARY_MAX = 280
const ORDER: Record<string, number> = { blocked: 0, review: 1, running: 2, ready: 3, scheduled: 4, todo: 5, triage: 6 }

/** Ids whose `show` is worth reading: every blocked card, the review card, the last two done. */
export function detailIds(name: string, tasks: Task[], doneLimit = 2): { id: string; board: string }[] {
  const mine = tasks.filter((t) => t.assignee === name)
  const wanted = mine.filter((t) => t.status === 'blocked' || t.status === 'review')
  const done = mine
    .filter((t) => t.status === 'done')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    .slice(0, doneLimit)
  return [...wanted, ...done].slice(0, 8).map((t) => ({ id: t.id, board: t.board ?? '' }))
}

function iso(sec?: number): string | undefined {
  return typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : undefined
}

function kindOf(raw: unknown): BlockKind {
  return raw === 'needs_input' ? 'needs_input' : raw === 'dependency' ? 'dependency' : 'other'
}

export function buildBrief(input: {
  name: string
  tasks: Task[]
  details: Map<string, TaskDetail | null>
  feed: FeedItem[]
  now?: Date
}): AgentBrief {
  const mine = input.tasks.filter((t) => t.assignee === input.name && t.status !== 'archived')

  const cards: BriefCard[] = mine
    .filter((t) => t.status !== 'done')
    .map((t) => {
      const card: BriefCard = {
        id: t.id,
        board: t.board ?? '',
        title: t.title,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }
      if (t.status === 'blocked') {
        const d = input.details.get(t.id) ?? null
        const ev = d ? [...d.events].reverse().find((e) => e.kind === 'blocked') : undefined
        const reason = (ev?.payload?.reason as string | undefined) ?? d?.lastFailureError ?? undefined
        card.kind = kindOf(ev?.payload?.kind)
        card.blockedAt = iso(ev?.created_at) ?? t.updatedAt
        if (typeof reason === 'string' && reason.trim()) card.reason = reason.trim().slice(0, REASON_MAX)
      }
      return card
    })
    .sort((a, b) => {
      const o = (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9)
      if (o) return o
      // within blocked, the one that has waited longest comes first
      return (a.blockedAt ?? a.updatedAt ?? '').localeCompare(b.blockedAt ?? b.updatedAt ?? '')
    })

  const recentDone: BriefDone[] = mine
    .filter((t) => t.status === 'done')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    .slice(0, 3)
    .map((t) => {
      const summary = input.details.get(t.id)?.latestSummary?.trim()
      return {
        id: t.id,
        board: t.board ?? '',
        title: t.title,
        completedAt: t.completedAt,
        ...(summary ? { summary: summary.slice(0, SUMMARY_MAX) } : {}),
      }
    })

  const reports = input.feed.filter((f) => f.agent === input.name && !f.read && f.kind !== 'assigned')
  return { name: input.name, cards, recentDone, reports, readAt: (input.now ?? new Date()).toISOString() }
}
