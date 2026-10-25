'use client'

import { useCallback, useEffect, useState } from 'react'
import AgentAvatar from './AgentAvatar'
import { describePresence } from './AgentStatusOverlay'
import { usePresence } from './usePresence'
import { UI_ROLE_LABEL } from './UiLabels'
import { fetchJson } from '@/lib/api'
import { ago } from '@/lib/ago'
import { useOffice } from '@/lib/store'
import { t as translate, type MessageKey } from '@/lib/i18n'
import { parseAssign } from '@/lib/hermes/mention'
import { presenceDot, presenceGroup } from '@/lib/office/presence'
import type { AgentBrief, BriefCard } from '@/lib/hermes/agent-brief'

const POLL_MS = 10_000
const REASON_SHORT = 260

/**
 * What opens when you click an agent in the team roster.
 *
 * The click lands on the NEXT DECISION for that agent, not on a card of labels:
 * - waiting on you → each blocked card with the reason Hermes recorded, how long it has waited,
 *   and a box to answer; "Trả lời & gỡ chặn" writes the answer into the card and unblocks it;
 * - a report waiting → read it, mark it read;
 * - in review → open the card;
 * - working → the card in hand and a box to steer it;
 * - idle → hand it a new job right here, with what it last finished and what is queued.
 * Every write goes through the same routes (and the same write guard) as the Kanban drawer.
 */
export default function AgentJourneyPanel() {
  const name = useOffice((s) => s.selectedAgent)
  const openTaskId = useOffice((s) => s.openTaskId)
  // The task drawer opens on the same side: while it is open it is the thing to look at.
  if (!name || openTaskId) return null
  return <Journey key={name} name={name} />
}

function Reason({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > REASON_SHORT
  return (
    <p className="vp-j-reason">
      {open || !long ? text : `${text.slice(0, REASON_SHORT).trimEnd()}…`}
      {long && (
        <button type="button" className="vp-j-link" onClick={() => setOpen((v) => !v)}>
          {open ? translate('Journey.less') : translate('Journey.more')}
        </button>
      )}
    </p>
  )
}

function Journey({ name }: { name: string }) {
  const agent = useOffice((s) => s.agents.find((a) => a.name === name))
  const member = useOffice((s) => s.team.find((m) => m.name === name))
  const boards = useOffice((s) => s.boards)
  const board = useOffice((s) => s.board)
  const select = useOffice((s) => s.select)
  const setBoard = useOffice((s) => s.setBoard)
  const openTask = useOffice((s) => s.openTask)
  const loadTasks = useOffice((s) => s.load)
  const loadTeam = useOffice((s) => s.loadTeam)
  const setFeedSummary = useOffice((s) => s.setFeedSummary)
  const row = usePresence().find((r) => r.name === name)

  const [brief, setBrief] = useState<AgentBrief | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [assignText, setAssignText] = useState('')
  const [assignBoard, setAssignBoard] = useState('')
  const [confirming, setConfirming] = useState(false)

  const reload = useCallback(async () => {
    const res = await fetchJson<AgentBrief>(`/api/hermes/team/${encodeURIComponent(name)}`, { cache: 'no-store' })
    if (res.ok && res.data) {
      setBrief(res.data)
      setErr(null)
    } else setErr(res.error)
  }, [name])

  useEffect(() => {
    void reload()
    const id = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(id)
  }, [reload])

  useEffect(() => {
    if (!assignBoard && (board || boards.length)) setAssignBoard(board || boards.find((b) => b.current)?.slug || boards[0]?.slug || '')
  }, [assignBoard, board, boards])

  const refreshAll = async () => {
    await Promise.all([reload(), loadTasks(), loadTeam()])
  }

  const post = (url: string, body: unknown) =>
    fetchJson<Record<string, unknown>>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const taskUrl = (c: BriefCard) => `/api/hermes/tasks/${encodeURIComponent(c.id)}?board=${encodeURIComponent(c.board)}`
  const setDraft = (id: string, v: string) => setDrafts((d) => ({ ...d, [id]: v }))

  const openCard = (c: { id: string; board: string }) => {
    if (c.board) setBoard(c.board)
    openTask(c.id)
  }

  async function run(key: string, fn: () => Promise<string | null>) {
    setBusy(key)
    setNote(null)
    try {
      setNote(await fn())
    } catch (e) {
      setNote(translate('Journey.error', { msg: (e as Error).message }))
    } finally {
      setBusy(null)
    }
    await refreshAll()
  }

  const answer = (c: BriefCard) =>
    run(`ans:${c.id}`, async () => {
      const text = (drafts[c.id] ?? '').trim()
      if (!text) return null
      if (!window.confirm(translate('Journey.answerConfirm', { title: c.title }))) return null
      const said = await post(taskUrl(c), { action: 'steer', message: text })
      if (!said.ok) throw new Error(said.error ?? 'steer')
      const freed = await post(taskUrl(c), { action: 'promote', message: text.slice(0, 300) })
      if (!freed.ok) return translate('Journey.answeredCommentOnly', { msg: freed.error ?? '' })
      setDraft(c.id, '')
      return translate('Journey.answered')
    })

  const archive = (c: BriefCard) =>
    run(`arc:${c.id}`, async () => {
      if (!window.confirm(translate('Journey.archiveConfirm', { title: c.title }))) return null
      const res = await post(`/api/hermes/tasks/archive?board=${encodeURIComponent(c.board)}`, { action: 'archive', ids: [c.id] })
      if (!res.ok) throw new Error(res.error ?? 'archive')
      return translate('Journey.archived')
    })

  const steer = (c: BriefCard) =>
    run(`steer:${c.id}`, async () => {
      const text = (drafts[c.id] ?? '').trim()
      if (!text) return null
      const res = await post(taskUrl(c), { action: 'steer', message: text })
      if (!res.ok) throw new Error(res.error ?? 'steer')
      setDraft(c.id, '')
      return translate('Journey.steered')
    })

  const markRead = (ids: number[]) =>
    run('ack', async () => {
      const res = await fetchJson<{ unread: number; reporting: string[] }>('/api/hermes/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ack', ids }),
      })
      if (!res.ok || !res.data) throw new Error(res.error ?? 'ack')
      setFeedSummary(res.data)
      return null
    })

  const parsed = assignText.trim() ? parseAssign(`@${name} ${assignText}`, [name]) : null
  const assign = () =>
    run('assign', async () => {
      const res = await fetchJson<{ task?: { title: string } }>('/api/hermes/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'assign', text: `@${name} ${assignText}`, board: assignBoard }),
      })
      if (!res.ok || !res.data) throw new Error(res.error ?? 'assign')
      setAssignText('')
      setConfirming(false)
      return translate('Journey.assigned', { title: res.data.task?.title ?? '' })
    })

  const cards = brief?.cards ?? []
  const blocked = cards.filter((c) => c.status === 'blocked')
  const review = cards.filter((c) => c.status === 'review')
  const running = cards.filter((c) => c.status === 'running')
  const queue = cards.filter((c) => c.status !== 'blocked' && c.status !== 'review' && c.status !== 'running')
  const kind = row?.kind ?? 'idle'
  const group = presenceGroup(kind)
  const idleSince = brief?.recentDone[0]?.completedAt

  const kindLabel = (c: BriefCard) =>
    translate(c.kind === 'needs_input' ? 'Journey.kindNeedsInput' : c.kind === 'dependency' ? 'Journey.kindDependency' : 'Journey.kindOther')

  const assignBox = (
    <details className="vp-j-assign" open={kind === 'idle'}>
      <summary>{translate('Journey.assignTitle', { name })}</summary>
      {confirming && parsed?.ok ? (
        <div className="vp-j-confirm">
          <p>{translate('Journey.assignConfirm', { name, board: assignBoard })}</p>
          <b>{parsed.title}</b>
          <div className="vp-j-actions">
            <button className="vp-btn" disabled={busy === 'assign'} onClick={() => void assign()}>
              {busy === 'assign' ? '…' : translate('Journey.assignSend')}
            </button>
            <button className="vp-btn vp-btn-ghost" disabled={busy === 'assign'} onClick={() => setConfirming(false)}>
              {translate('Journey.assignEdit')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <textarea
            className="vp-input"
            rows={3}
            value={assignText}
            placeholder={translate('Journey.assignPlaceholder')}
            onChange={(e) => setAssignText(e.target.value)}
          />
          <div className="vp-j-actions">
            <select className="vp-input vp-j-board" value={assignBoard} onChange={(e) => setAssignBoard(e.target.value)} aria-label={translate('Journey.assignBoard')}>
              {boards.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {b.name}
                </option>
              ))}
            </select>
            <button className="vp-btn" disabled={!parsed?.ok} onClick={() => setConfirming(true)}>
              {translate('Journey.assign')}
            </button>
          </div>
        </>
      )}
    </details>
  )

  return (
    <aside className="vp-journey" aria-label={name}>
      <header className="vp-j-head">
        <AgentAvatar name={name} role={agent?.role ?? null} status={presenceDot(kind)} size={46} />
        <div className="vp-j-id">
          <b>{agent?.displayName ?? name}</b>
          <span>
            {[agent ? (UI_ROLE_LABEL[agent.role] ?? agent.role) : null, member?.model ?? translate('Journey.modelFallback')].filter(Boolean).join(' · ')}
          </span>
        </div>
        <button className="vp-x" onClick={() => select(null)} aria-label={translate('Journey.close')}>
          ×
        </button>
      </header>
      <p className="vp-j-status" data-g={group}>
        {row ? describePresence(row) : ''}
        {kind === 'idle' && idleSince ? ` · ${translate('Journey.idleSince', { when: ago(idleSince) })}` : ''}
      </p>
      {note && <p className="vp-j-note">{note}</p>}
      {err && !brief && <p className="vp-err">{translate('Journey.error', { msg: err })}</p>}
      {!brief && !err && <p className="vp-muted">{translate('Journey.loading')}</p>}

      {brief && (
        <div className="vp-j-body">
          {brief.reports.length > 0 && (
            <section>
              <h3 data-g="waiting">{translate('Journey.reports')}</h3>
              {brief.reports.map((r) => (
                <div key={r.id} className="vp-j-card">
                  <b>
                    {r.title} <i>{translate(r.kind === 'done' ? 'Journey.reportDone' : 'Journey.reportBlocked')}</i>
                  </b>
                  {r.text && <p className="vp-j-reason">{r.text}</p>}
                  <div className="vp-j-actions">
                    <button className="vp-btn" disabled={busy === 'ack'} onClick={() => void markRead([r.id])}>
                      {translate('Journey.markRead')}
                    </button>
                    <button className="vp-btn vp-btn-ghost" onClick={() => openCard({ id: r.taskId, board: r.board })}>
                      {translate('Journey.openCard')}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {blocked.length > 0 && (
            <section>
              <h3 data-g="waiting">{translate('Journey.waiting')}</h3>
              {blocked.map((c, i) => (
                <details key={c.id} className="vp-j-card" open={i === 0}>
                  <summary>
                    <span className="vp-j-title">{c.title}</span>
                    <span className="vp-j-meta">
                      {[kindLabel(c), c.board, c.blockedAt ? translate('Journey.blockedFor', { when: ago(c.blockedAt) }) : null].filter(Boolean).join(' · ')}
                    </span>
                  </summary>
                  {c.reason ? <Reason text={c.reason} /> : <p className="vp-muted">{translate('Journey.noReason')}</p>}
                  {c.kind !== 'dependency' && (
                    <>
                      <textarea
                        className="vp-input"
                        rows={3}
                        value={drafts[c.id] ?? ''}
                        placeholder={translate('Journey.answerPlaceholder')}
                        aria-label={translate('Journey.answerLabel', { name })}
                        onChange={(e) => setDraft(c.id, e.target.value)}
                      />
                      <div className="vp-j-actions">
                        <button className="vp-btn" disabled={busy !== null || !(drafts[c.id] ?? '').trim()} onClick={() => void answer(c)}>
                          {busy === `ans:${c.id}` ? '…' : translate('Journey.answerSend')}
                        </button>
                        <button className="vp-btn vp-btn-ghost" onClick={() => openCard(c)}>
                          {translate('Journey.openCard')}
                        </button>
                      </div>
                    </>
                  )}
                  {c.kind === 'dependency' && (
                    <div className="vp-j-actions">
                      <button className="vp-btn" disabled={busy !== null} onClick={() => void archive(c)}>
                        {busy === `arc:${c.id}` ? '…' : translate('Journey.archive')}
                      </button>
                      <button className="vp-btn vp-btn-ghost" onClick={() => openCard(c)}>
                        {translate('Journey.openCard')}
                      </button>
                    </div>
                  )}
                </details>
              ))}
            </section>
          )}

          {review.length > 0 && (
            <section>
              <h3 data-g="waiting">{translate('Journey.review')}</h3>
              {review.map((c) => (
                <div key={c.id} className="vp-j-card">
                  <b>{c.title}</b>
                  <div className="vp-j-actions">
                    <button className="vp-btn" onClick={() => openCard(c)}>
                      {translate('Journey.reviewOpen')}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {running.length > 0 && (
            <section>
              <h3 data-g="working">{translate('Journey.running')}</h3>
              {running.map((c) => (
                <div key={c.id} className="vp-j-card">
                  <b>{c.title}</b>
                  <span className="vp-j-meta">{c.board}</span>
                  <textarea
                    className="vp-input"
                    rows={2}
                    value={drafts[c.id] ?? ''}
                    placeholder={translate('Journey.steerPlaceholder')}
                    onChange={(e) => setDraft(c.id, e.target.value)}
                  />
                  <div className="vp-j-actions">
                    <button className="vp-btn" disabled={busy !== null || !(drafts[c.id] ?? '').trim()} onClick={() => void steer(c)}>
                      {busy === `steer:${c.id}` ? '…' : translate('Journey.steerSend')}
                    </button>
                    <button className="vp-btn vp-btn-ghost" onClick={() => openCard(c)}>
                      {translate('Journey.openCard')}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {kind === 'talking' && row?.peer && (
            <div className="vp-j-actions">
              <button className="vp-btn vp-btn-ghost" onClick={() => select(row.peer!)}>
                {translate('Journey.peerOpen', { peer: row.peer })}
              </button>
            </div>
          )}

          {kind === 'idle' && assignBox}

          {queue.length > 0 && (
            <section>
              <h3>{translate('Journey.queue')}</h3>
              <ul className="vp-j-list">
                {queue.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => openCard(c)}>
                      <span>{c.title}</span>
                      <i>{translate(`Journey.status.${c.status}` as MessageKey)}</i>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {kind !== 'idle' && assignBox}

          <section>
            <h3>{translate('Journey.recent')}</h3>
            {brief.recentDone.length === 0 ? (
              <p className="vp-muted">{translate('Journey.noWorkYet')}</p>
            ) : (
              <ul className="vp-j-list">
                {brief.recentDone.map((d) => (
                  <li key={d.id}>
                    <button type="button" onClick={() => openCard(d)}>
                      <span>{d.title}</span>
                      <i>{d.completedAt ? translate('Journey.doneAgo', { when: ago(d.completedAt) }) : ''}</i>
                      {d.summary && <em>{d.summary}</em>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </aside>
  )
}
