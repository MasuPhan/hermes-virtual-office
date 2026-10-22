/**
 * Archive / delete Kanban cards from the office.
 *
 * What the Hermes CLI (v0.21.6) offers, measured from `hermes kanban archive --help` and
 * hermes_cli/kanban_db.py:
 *   - `kanban [--board B] archive <id>...`       soft: status → archived (reversible only by
 *                                                  a direct DB write; there is NO unarchive verb)
 *   - `kanban [--board B] archive --rm <id>...`  HARD delete of ALREADY-archived ids
 *                                                  (rows + events/comments/links), irreversible
 *   - both exit 1 if any id was refused, printing per-id "Archived X" / "cannot archive X".
 *   - archiving a RUNNING card terminates its worker. The office refuses running cards.
 *
 * Outcomes are verified by re-reading the board (`list --archived`) instead of trusting
 * the exit code, so a partial failure reports exactly which ids changed.
 */
import { kanbanRaw, listTasks } from './kanban'
import type { Task } from '@/types/hermes'

export const TASK_ID_RE = /^t_[A-Za-z0-9]{4,40}$/
export const MAX_IDS = 100
const CHUNK = 40

export type ArchiveAction = 'archive' | 'delete'
export type IdOutcome = { id: string; ok: boolean; code?: 'not_found' | 'running' | 'already_archived' | 'refused'; title?: string }

export class TaskArchiveError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message)
  }
}

/** Validate the id list: 1..100 well-formed ids, deduplicated. Throws TaskArchiveError(400). */
export function validateIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.length) throw new TaskArchiveError('invalid_request', 'Cần danh sách ids', 400)
  if (raw.length > MAX_IDS) throw new TaskArchiveError('invalid_request', `Tối đa ${MAX_IDS} công việc mỗi lần`, 400)
  const ids = [...new Set(raw.map((x) => String(x ?? '')))]
  const bad = ids.find((id) => !TASK_ID_RE.test(id))
  if (bad !== undefined) throw new TaskArchiveError('invalid_task_id', `Mã công việc không hợp lệ: "${bad.slice(0, 60)}"`, 400)
  return ids
}

/** The exact confirm token a delete must carry: binds the confirmation to these ids. */
export function deleteConfirmToken(ids: string[]): string {
  return `delete:${[...ids].sort().join(',')}`
}

async function boardRows(): Promise<Map<string, Task>> {
  const rows = await listTasks({ includeArchived: true })
  return new Map(rows.map((t) => [t.id, t]))
}

async function run(args: string[]): Promise<void> {
  // Tolerant: exit 1 only means "some id refused"; the re-read below is the truth.
  await kanbanRaw(args).catch(() => '')
}

/**
 * Archive (soft) the given cards on the scoped board. Running cards and unknown ids are
 * refused up front; already-archived ids are reported, not re-sent.
 */
export async function archiveCards(ids: string[]): Promise<IdOutcome[]> {
  const before = await boardRows()
  const out = new Map<string, IdOutcome>()
  const send: string[] = []
  for (const id of ids) {
    const t = before.get(id)
    if (!t) out.set(id, { id, ok: false, code: 'not_found' })
    else if (t.status === 'running') out.set(id, { id, ok: false, code: 'running', title: t.title })
    else if (t.status === 'archived') out.set(id, { id, ok: false, code: 'already_archived', title: t.title })
    else send.push(id)
  }
  for (let i = 0; i < send.length; i += CHUNK) await run(['archive', ...send.slice(i, i + CHUNK)])
  const after = send.length ? await boardRows() : before
  for (const id of send) {
    const ok = after.get(id)?.status === 'archived'
    out.set(id, { id, ok, title: before.get(id)?.title, ...(ok ? {} : { code: 'refused' as const }) })
  }
  return ids.map((id) => out.get(id)!)
}

/**
 * Permanently delete cards on the scoped board. The CLI only deletes archived rows, so a
 * live (non-running) card is archived first, then purged. Running cards are refused.
 */
export async function deleteCards(ids: string[]): Promise<IdOutcome[]> {
  const before = await boardRows()
  const out = new Map<string, IdOutcome>()
  const toArchive: string[] = []
  const toPurge: string[] = []
  for (const id of ids) {
    const t = before.get(id)
    if (!t) out.set(id, { id, ok: false, code: 'not_found' })
    else if (t.status === 'running') out.set(id, { id, ok: false, code: 'running', title: t.title })
    else {
      if (t.status !== 'archived') toArchive.push(id)
      toPurge.push(id)
    }
  }
  for (let i = 0; i < toArchive.length; i += CHUNK) await run(['archive', ...toArchive.slice(i, i + CHUNK)])
  for (let i = 0; i < toPurge.length; i += CHUNK) await run(['archive', '--rm', ...toPurge.slice(i, i + CHUNK)])
  const after = toPurge.length ? await boardRows() : before
  for (const id of toPurge) {
    const ok = !after.has(id)
    out.set(id, { id, ok, title: before.get(id)?.title, ...(ok ? {} : { code: 'refused' as const }) })
  }
  return ids.map((id) => out.get(id)!)
}
