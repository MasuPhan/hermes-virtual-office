import { officeDb } from '@/lib/office/db'
import { getTaskDetail, listBoards, listTasks, type TaskDetail } from './kanban'
import type { Task, TaskStatus } from '@/types/hermes'

export { parseAssign, type ParsedAssign } from './mention'

/**
 * "Phòng chung": the office room feed.
 *
 * Two kinds of line land here:
 * - REPORTS — an agent's card reached `done` or `blocked`. Hermes has no push channel
 *   the office can subscribe to, so the server compares each board with the statuses it
 *   saw last time (kept in office.db) and turns every change into one report. The first
 *   read of a board only records it: an office that was never watching must not announce
 *   thirty old completions at once.
 * - ASSIGNMENTS — "@developer viết API …" typed in the room became a card.
 *
 * A report stays unread until someone acknowledges it; while it is unread and recent the
 * agent walks to the CEO suite to deliver it (see `reportingAgents` and duty.ts).
 */

export type FeedKind = 'done' | 'blocked' | 'assigned'

export type FeedItem = {
  id: number
  kind: FeedKind
  agent: string | null
  board: string
  taskId: string
  title: string
  /** Completion summary, block reason, or the assignment text. */
  text: string
  at: string
  read: boolean
}

/** Reports older than this no longer send the agent upstairs (it still shows in the feed). */
export const REPORT_WALK_MS = 6 * 60 * 60 * 1000
const POLL_TTL_MS = 15_000
/** At most this many `show` reads per poll; a burst of changes is reported without text. */
const DETAIL_CAP = 10
const TEXT_MAX = 600

let migrated = false
function db() {
  const d = officeDb()
  if (!migrated) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS feed_board (
        board     TEXT PRIMARY KEY,
        seeded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feed_task (
        board    TEXT NOT NULL,
        task_id  TEXT NOT NULL,
        status   TEXT NOT NULL,
        title    TEXT NOT NULL,
        assignee TEXT,
        PRIMARY KEY (board, task_id)
      );
      CREATE TABLE IF NOT EXISTS feed_item (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        kind    TEXT NOT NULL,
        agent   TEXT,
        board   TEXT NOT NULL,
        task_id TEXT NOT NULL,
        title   TEXT NOT NULL,
        text    TEXT NOT NULL DEFAULT '',
        at      TEXT NOT NULL,
        read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS feed_item_at ON feed_item(at);
    `)
    migrated = true
  }
  return d
}

/** Test-only: forget the migration flag after the DB handle was reset. */
export function _resetFeedForTest(): void {
  migrated = false
  pollMemo = null
  polledOnce = false
}

/* ------------------------------------------------------------ transitions -- */

export type Seen = { status: TaskStatus; title: string; assignee: string | null }
export type Transition = { task: Task; kind: 'done' | 'blocked' }

/**
 * Status changes worth a report, for ONE board. Pure.
 *
 * - `seeded` false: the board was never read before → nothing is a change yet.
 * - a known card whose status moved INTO done/blocked → report.
 * - a card first seen already done/blocked on a seeded board → report (it was created
 *   and finished between two reads, or created blocked).
 * - archived rows are ignored: archiving is housekeeping, not news.
 */
export function transitions(prev: Map<string, Seen>, rows: Task[], seeded: boolean): Transition[] {
  if (!seeded) return []
  const out: Transition[] = []
  for (const t of rows) {
    if (t.status !== 'done' && t.status !== 'blocked') continue
    const before = prev.get(t.id)
    if (before && before.status === t.status) continue
    out.push({ task: t, kind: t.status })
  }
  return out
}

/** What a report says, from `show`: the completion summary or the latest block reason. */
export function reportText(kind: 'done' | 'blocked', detail: TaskDetail | null): string {
  if (!detail) return ''
  const want = kind === 'done' ? 'completed' : 'blocked'
  const ev = [...detail.events].reverse().find((e) => e.kind === want)
  const raw =
    kind === 'done'
      ? (ev?.payload?.summary as string | undefined) ?? detail.latestSummary
      : (ev?.payload?.reason as string | undefined) ?? detail.lastFailureError
  return typeof raw === 'string' ? raw.trim().slice(0, TEXT_MAX) : ''
}

/* ------------------------------------------------------------------- poll -- */

let pollMemo: { at: number; run: Promise<number> } | null = null

/** Read every board, record changes as reports. Returns how many were added. Memoised 15 s. */
export function pollFeed(): Promise<number> {
  if (pollMemo && Date.now() - pollMemo.at < POLL_TTL_MS) return pollMemo.run
  const run = pollOnce().catch(() => 0)
  pollMemo = { at: Date.now(), run }
  void run.then(() => {
    polledOnce = true
  })
  return run
}

let polledOnce = false

/**
 * The office's own poll only needs the counts, which sit in office.db. After the first pass
 * it starts the next pass (if one is due) and answers from what is stored, instead of making
 * every poll wait ~2 s for a read of all boards: the report appears one pass later at worst.
 */
export function pollFeedSoft(): Promise<unknown> {
  const run = pollFeed()
  return polledOnce ? Promise.resolve() : run
}

async function pollOnce(): Promise<number> {
  const boards = await listBoards()
  const d = db()
  const seededRows = d.prepare(`SELECT board FROM feed_board`).all() as { board: string }[]
  const seeded = new Set(seededRows.map((r) => r.board))
  let added = 0
  let details = 0
  for (const b of boards) {
    let rows: Task[]
    try {
      rows = (await listTasks({ board: b.slug })).filter((t) => t.status !== 'archived')
    } catch {
      continue // one unreadable board must not stop the others, nor wipe its snapshot
    }
    const prevRows = d
      .prepare(`SELECT task_id, status, title, assignee FROM feed_task WHERE board = ?`)
      .all(b.slug) as { task_id: string; status: TaskStatus; title: string; assignee: string | null }[]
    const prev = new Map(prevRows.map((r) => [r.task_id, { status: r.status, title: r.title, assignee: r.assignee }]))
    const found = transitions(prev, rows, seeded.has(b.slug))
    const at = new Date().toISOString()
    for (const tr of found) {
      const detail = details < DETAIL_CAP ? await getTaskDetail(tr.task.id, b.slug) : null
      details += 1
      d.prepare(
        `INSERT INTO feed_item (kind, agent, board, task_id, title, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(tr.kind, tr.task.assignee, b.slug, tr.task.id, tr.task.title.slice(0, 300), reportText(tr.kind, detail), at)
      added += 1
    }
    d.exec('BEGIN')
    try {
      d.prepare(`DELETE FROM feed_task WHERE board = ?`).run(b.slug)
      const ins = d.prepare(`INSERT INTO feed_task (board, task_id, status, title, assignee) VALUES (?, ?, ?, ?, ?)`)
      for (const t of rows) ins.run(b.slug, t.id, t.status, t.title.slice(0, 300), t.assignee)
      if (!seeded.has(b.slug)) d.prepare(`INSERT OR IGNORE INTO feed_board (board, seeded_at) VALUES (?, ?)`).run(b.slug, at)
      d.exec('COMMIT')
    } catch (err) {
      d.exec('ROLLBACK')
      throw err
    }
  }
  return added
}

/* ------------------------------------------------------------- read/write -- */

type Row = { id: number; kind: FeedKind; agent: string | null; board: string; task_id: string; title: string; text: string; at: string; read_at: string | null }

function toItem(r: Row): FeedItem {
  return { id: r.id, kind: r.kind, agent: r.agent, board: r.board, taskId: r.task_id, title: r.title, text: r.text, at: r.at, read: r.read_at !== null }
}

export function listFeed(limit = 80): FeedItem[] {
  const rows = db().prepare(`SELECT * FROM feed_item ORDER BY id DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 200)) as Row[]
  return rows.map(toItem)
}

export function unreadCount(): number {
  return (db().prepare(`SELECT COUNT(*) AS n FROM feed_item WHERE read_at IS NULL AND kind != 'assigned'`).get() as { n: number }).n
}

/** Agents with an unread recent report, oldest report first (that is the queue order upstairs). */
export function reportingAgents(now = Date.now()): string[] {
  const since = new Date(now - REPORT_WALK_MS).toISOString()
  const rows = db()
    .prepare(
      `SELECT agent, MIN(at) AS first FROM feed_item
       WHERE read_at IS NULL AND kind IN ('done', 'blocked') AND agent IS NOT NULL AND at >= ?
       GROUP BY agent ORDER BY first`,
    )
    .all(since) as { agent: string }[]
  return rows.map((r) => r.agent)
}

/** Mark reports read: given ids, or every unread one. Returns rows changed. */
export function ackFeed(ids: number[] | 'all'): number {
  const at = new Date().toISOString()
  if (ids === 'all') return Number(db().prepare(`UPDATE feed_item SET read_at = ? WHERE read_at IS NULL`).run(at).changes)
  let n = 0
  const st = db().prepare(`UPDATE feed_item SET read_at = ? WHERE id = ? AND read_at IS NULL`)
  for (const id of ids.slice(0, 200)) n += Number(st.run(at, id).changes)
  return n
}

export function recordAssignment(input: { agent: string; board: string; taskId: string; title: string; text: string }): FeedItem {
  const at = new Date().toISOString()
  const r = db()
    .prepare(`INSERT INTO feed_item (kind, agent, board, task_id, title, text, at, read_at) VALUES ('assigned', ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.agent, input.board, input.taskId, input.title.slice(0, 300), input.text.slice(0, TEXT_MAX), at, at)
  return toItem(db().prepare(`SELECT * FROM feed_item WHERE id = ?`).get(Number(r.lastInsertRowid)) as Row)
}
