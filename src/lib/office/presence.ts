import type { Agent, AgentStatus, Meeting } from '@/types/hermes'

/**
 * "Who is doing what right now", one line per agent, for the roster overlay on the 3D view.
 *
 * Pure: it only folds signals the office already polls (agent status, the live meeting, A2A
 * pairs, live chats, unread reports, blocked cards), so the same rules can be tested without
 * a browser and the overlay cannot disagree with the floor — the order below mirrors `dutyOf`
 * in duty.ts (a meeting beats a call beats desk work …).
 */

export type PresenceKind =
  | 'meeting' // in a live meeting
  | 'talking' // on an agent-to-agent call
  | 'working' // has a running card
  | 'chat' // the operator is chatting with it
  | 'reporting' // finished/blocked work waiting for the operator to read
  | 'review' // a card waits for review
  | 'blocked' // waiting for the operator: a blocked card or a pending approval
  | 'idle'

export type PresenceRow = {
  name: string
  kind: PresenceKind
  /** Title of the card in hand (working / review). */
  task?: string
  /** The other side of an A2A call. */
  peer?: string
  /** Topic of the live meeting. */
  topic?: string
  /** Blocked cards it holds, when known. */
  blockedCards?: number
  /** idle: cards waiting in its queue (ready / todo / scheduled), when known. */
  queued?: number
}

export type PresenceInput = {
  agents: Pick<Agent, 'name' | 'status' | 'currentTaskTitle'>[]
  meeting: Pick<Meeting, 'state' | 'topic' | 'participants'> | null
  a2a: { agent: string; peer: string | null }[]
  chatLive: string[]
  reporting: string[]
  /** Blocked cards per agent, over every board (from /api/hermes/team). */
  blockedCards?: Record<string, number>
  /** Cards waiting in each agent's queue, over every board (from /api/hermes/team). */
  queuedCards?: Record<string, number>
}

/** Lower comes first in the list: what needs the operator, then who is working together, then work, then rest. */
const RANK: Record<PresenceKind, number> = {
  blocked: 0,
  reporting: 1,
  review: 2,
  meeting: 3,
  talking: 4,
  working: 5,
  chat: 6,
  idle: 7,
}

export function presenceRows(i: PresenceInput): PresenceRow[] {
  const inMeeting = new Set(
    i.meeting && (i.meeting.state === 'queued' || i.meeting.state === 'running') ? i.meeting.participants : [],
  )
  const talking = new Map(i.a2a.map((p) => [p.agent, p.peer]))
  const chat = new Set(i.chatLive)
  const reporting = new Set(i.reporting)

  const rows = i.agents.map((a): PresenceRow => {
    const blockedCards = i.blockedCards?.[a.name] ?? 0
    const task = a.currentTaskTitle ?? undefined
    if (inMeeting.has(a.name)) return { name: a.name, kind: 'meeting', topic: i.meeting?.topic }
    if (talking.has(a.name)) return { name: a.name, kind: 'talking', peer: talking.get(a.name) ?? undefined }
    if (a.status === 'working') return { name: a.name, kind: 'working', task }
    if (chat.has(a.name)) return { name: a.name, kind: 'chat' }
    if (reporting.has(a.name)) return { name: a.name, kind: 'reporting' }
    if (a.status === 'review') return { name: a.name, kind: 'review', task }
    if (a.status === 'blocked' || blockedCards > 0) {
      return { name: a.name, kind: 'blocked', ...(blockedCards > 0 ? { blockedCards } : {}) }
    }
    const queued = i.queuedCards?.[a.name] ?? 0
    return { name: a.name, kind: 'idle', ...(queued > 0 ? { queued } : {}) }
  })

  return rows.sort((x, y) => RANK[x.kind] - RANK[y.kind] || x.name.localeCompare(y.name))
}

/** The dot on a portrait: reuses the status colours of the rest of the office. */
export function presenceDot(kind: PresenceKind): AgentStatus {
  switch (kind) {
    case 'meeting':
    case 'talking':
      return 'meeting'
    case 'working':
    case 'chat':
      return 'working'
    case 'reporting':
    case 'review':
      return 'review'
    case 'blocked':
      return 'blocked'
    default:
      return 'idle'
  }
}

export type PresenceGroup = 'waiting' | 'together' | 'working' | 'idle'

/** The four sections of the overlay, in the order they are listed. */
export const PRESENCE_GROUPS: readonly PresenceGroup[] = ['waiting', 'together', 'working', 'idle']

export function presenceGroup(kind: PresenceKind): PresenceGroup {
  if (kind === 'blocked' || kind === 'reporting' || kind === 'review') return 'waiting'
  if (kind === 'meeting' || kind === 'talking') return 'together'
  if (kind === 'working' || kind === 'chat') return 'working'
  return 'idle'
}

export type PresenceSummary = Record<PresenceGroup, number>

/** The four numbers in the overlay header. */
export function presenceSummary(rows: PresenceRow[]): PresenceSummary {
  const s: PresenceSummary = { waiting: 0, together: 0, working: 0, idle: 0 }
  for (const r of rows) s[presenceGroup(r.kind)] += 1
  return s
}
