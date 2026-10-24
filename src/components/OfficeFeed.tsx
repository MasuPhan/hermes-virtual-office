'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FullPanel from './FullPanel'
import AgentAvatar from './AgentAvatar'
import { fetchJson } from '@/lib/api'
import { useOffice } from '@/lib/store'
import { formatLocale, t as translate } from '@/lib/i18n'
import { parseAssign } from '@/lib/hermes/mention'
import type { FeedItem } from '@/lib/hermes/feed'
import type { TeamMember } from '@/lib/hermes/team'
import type { AgentRole } from '@/types/hermes'

type FeedReply = { items: FeedItem[]; unread: number; reporting: string[] }
const POLL_MS = 10_000

function taskHref(i: FeedItem): string {
  return `/kanban?task=${encodeURIComponent(i.taskId)}&board=${encodeURIComponent(i.board)}`
}

function clock(iso: string): string {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString(formatLocale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(formatLocale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/**
 * Phòng chung — the office room.
 *
 * Reports arrive here when an agent's card reaches done or blocked (the server diffs the
 * boards, see lib/hermes/feed.ts); while a report is unread the agent stands in the CEO
 * suite. "@agent việc …" in the composer becomes a card after one confirmation, because
 * creating a card is a real write to Hermes.
 */
export default function OfficeFeed({ open, onClose }: { open: boolean; onClose: () => void }) {
  const boards = useOffice((s) => s.boards)
  const currentBoard = useOffice((s) => s.board)
  const setFeedSummary = useOffice((s) => s.setFeedSummary)

  const [items, setItems] = useState<FeedItem[]>([])
  const [members, setMembers] = useState<TeamMember[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [board, setBoard] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const roles = useMemo(() => new Map<string, AgentRole | null>(members.map((m) => [m.name, m.role])), [members])
  const names = useMemo(() => members.map((m) => m.name), [members])

  const load = useCallback(async () => {
    const res = await fetchJson<FeedReply>('/api/hermes/feed', { cache: 'no-store' })
    if (res.ok && res.data) {
      setItems([...res.data.items].reverse())
      setFeedSummary({ unread: res.data.unread, reporting: res.data.reporting })
    } else setErr(res.error)
  }, [setFeedSummary])

  useEffect(() => {
    if (!open) return
    void load()
    void fetchJson<{ members: TeamMember[] }>('/api/hermes/team').then((r) => r.ok && r.data && setMembers(r.data.members))
    const id = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(id)
  }, [open, load])

  useEffect(() => {
    if (!board && (currentBoard || boards.length)) setBoard(currentBoard || boards.find((b) => b.current)?.slug || boards[0]?.slug || '')
  }, [board, currentBoard, boards])

  // Newest at the bottom, like a chat: keep the view pinned there as lines arrive.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [items.length])

  if (!open) return null

  const parsed = draft.trim() ? parseAssign(draft, names) : null
  // "@dev" being typed: offer the names that start with it.
  const typing = /[@＠]([a-z0-9_-]*)$/i.exec(draft)
  const suggestions = typing ? names.filter((n) => n.startsWith(typing[1].toLowerCase())).slice(0, 6) : []
  const unread = items.filter((i) => !i.read && i.kind !== 'assigned')

  async function ack(ids: number[] | 'all') {
    const res = await fetchJson<{ unread: number; reporting: string[] }>('/api/hermes/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ack', ids }),
    })
    if (!res.ok || !res.data) return setErr(res.error)
    setFeedSummary(res.data)
    setItems((list) => list.map((i) => (ids === 'all' || ids.includes(i.id) ? { ...i, read: true } : i)))
  }

  async function assign() {
    setBusy(true)
    setErr(null)
    const res = await fetchJson<{ item: FeedItem }>('/api/hermes/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'assign', text: draft, board }),
    })
    setBusy(false)
    setConfirming(false)
    if (!res.ok || !res.data) return setErr(res.error)
    setItems((list) => [...list, res.data!.item])
    setDraft('')
    inputRef.current?.focus()
  }

  function pick(name: string) {
    setDraft((d) => d.replace(/[@＠][a-z0-9_-]*$/i, `@${name} `))
    inputRef.current?.focus()
  }

  return (
    <FullPanel
      onClose={onClose}
      label={translate('Feed.title')}
      title={translate('Feed.title')}
      tall
      className="vp-feed"
      bodyClassName="vp-feed-body"
      actions={
        unread.length > 0 && (
          <button className="vp-chip-btn" onClick={() => void ack('all')}>
            {translate('Feed.ackAll', { n: unread.length })}
          </button>
        )
      }
    >
      <div className="vp-feed-list" ref={listRef}>
        {items.length === 0 && <p className="vp-muted vp-feed-empty">{translate('Feed.empty')}</p>}
        {items.map((i) =>
          i.kind === 'assigned' ? (
            <div key={i.id} className="vp-feed-item vp-feed-mine">
              <div className="vp-feed-bubble">
                <div className="vp-feed-line">
                  {translate('Feed.assignedTo')} <b>@{i.agent}</b> · <Link href={taskHref(i)}>{i.title}</Link>
                </div>
                {i.text && i.text !== i.title && <div className="vp-feed-text">{i.text}</div>}
                <div className="vp-feed-meta">{i.board} · {clock(i.at)}</div>
              </div>
            </div>
          ) : (
            <div key={i.id} className={`vp-feed-item${i.read ? '' : ' unread'}`} data-kind={i.kind}>
              <AgentAvatar name={i.agent ?? '?'} role={roles.get(i.agent ?? '') ?? null} status={i.kind === 'blocked' ? 'blocked' : 'done'} size={36} />
              <div className="vp-feed-bubble">
                <div className="vp-feed-line">
                  <b>{i.agent ?? translate('Feed.nobody')}</b>{' '}
                  <span className="vp-feed-verb">{translate(i.kind === 'done' ? 'Feed.reportDone' : 'Feed.reportBlocked')}</span>{' '}
                  <Link href={taskHref(i)}>{i.title}</Link>
                </div>
                {i.text && <div className="vp-feed-text">{i.text}</div>}
                <div className="vp-feed-meta">
                  {i.board} · {clock(i.at)}
                  {!i.read && (
                    <button className="vp-feed-ack" onClick={() => void ack([i.id])}>
                      {translate('Feed.ack')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ),
        )}
      </div>

      <div className="vp-feed-compose">
        {err && <div className="vp-err">{err}</div>}
        {suggestions.length > 0 && (
          <div className="vp-feed-suggest" role="listbox" aria-label={translate('Feed.suggest')}>
            {suggestions.map((n) => (
              <button key={n} role="option" aria-selected={false} onClick={() => pick(n)}>
                <AgentAvatar name={n} role={roles.get(n) ?? null} size={22} /> @{n}
              </button>
            ))}
          </div>
        )}
        {confirming && parsed?.ok ? (
          <div className="vp-feed-confirm">
            <div>
              {translate('Feed.confirm')} <b>@{parsed.assignee}</b> · {translate('Feed.onBoard')} <b>{board}</b>
            </div>
            <div className="vp-feed-confirm-title">{parsed.title}</div>
            <div className="flex gap-2">
              <button className="vp-btn" disabled={busy} onClick={() => void assign()}>
                {busy ? '…' : translate('Feed.send')}
              </button>
              <button className="vp-btn vp-btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
                {translate('Feed.edit')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="vp-feed-row">
              <textarea
                ref={inputRef}
                className="vp-input vp-feed-input"
                rows={2}
                value={draft}
                placeholder={translate('Feed.placeholder')}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (suggestions.length === 1) pick(suggestions[0])
                    else if (parsed?.ok) setConfirming(true)
                  }
                }}
              />
              <button className="vp-btn" disabled={!parsed?.ok} onClick={() => setConfirming(true)}>
                {translate('Feed.assign')}
              </button>
            </div>
            <div className="vp-feed-hint">
              <select className="vp-input vp-feed-board" value={board} onChange={(e) => setBoard(e.target.value)} aria-label={translate('Feed.board')}>
                {boards.map((b) => (
                  <option key={b.slug} value={b.slug}>{b.name}</option>
                ))}
              </select>
              {/* While a name is still being typed, "@wr" is not an error yet: the list above helps. */}
              <span className={parsed && !parsed.ok && !typing ? 'vp-warn' : 'vp-muted'}>
                {parsed && !parsed.ok && !typing ? parsed.error : translate('Feed.hint')}
              </span>
            </div>
          </>
        )}
      </div>
    </FullPanel>
  )
}
