'use client'

import { useEffect, useRef, useState } from 'react'
import { fetchJson } from '@/lib/api'
import FullPanel from './FullPanel'

/**
 * Chat with agents — a WhatsApp-style list of conversations.
 *
 * An agent IS a profile: one name, one memory store. Sending a message to `jun`
 * runs the `jun` profile and stores the thread in that profile's session store, so
 * the conversation is remembered. There is no separate "profile" to choose — an
 * earlier version asked for one, which was a design mistake: `jun` the agent has no
 * second identity to pick from, and exposing the install's profile list as a choice
 * only confused things.
 *
 * The conversation list is every agent you can talk to, whether or not you have
 * messaged them yet, so a new chat is "pick a name and type".
 */

type Message = {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  ts: number
}

type Session = {
  id: string
  agent: string
  profile: string
  title: string
  updatedAt: string
  messageCount: number
}

/** Same human-readable relative time the cron panel uses. */
function when(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const mins = Math.round(diff / 60_000)
  if (mins < 1) return 'vừa xong'
  if (mins < 60) return `${mins} phút`
  if (diff < 86_400_000) return `${Math.round(mins / 60)} giờ`
  return `${Math.round(diff / 86_400_000)} ngày`
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}

/** Initials for the avatar bubble, like a chat app. */
function initials(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '')
  return (clean.slice(0, 2) || '?').toUpperCase()
}

/** A stable colour per name, so the same agent always looks the same. */
function hue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

export default function ChatPanel({
  open,
  onClose,
  onAgentCreated,
}: {
  open: boolean
  onClose: () => void
  /** Called after creating an agent, so the office can refresh its roster. */
  onAgentCreated?: () => void
}) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [agents, setAgents] = useState<string[]>([])
  const [profiles, setProfiles] = useState<string[]>([])

  /** null = the conversation list; a name = that chat. */
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [session, setSession] = useState<Session | null>(null)

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  /** The new-agent form. */
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)

  const scroller = useRef<HTMLDivElement | null>(null)

  async function loadList() {
    setLoading(true)
    setErr(null)
    const res = await fetchJson<{
      sessions?: Session[]
      agents?: string[]
      profiles?: string[]
    }>('/api/hermes/chat', { cache: 'no-store' })
    if (!res.ok) {
      setErr(res.error || 'không tải được danh sách trò chuyện')
      setLoading(false)
      return
    }
    setSessions(res.data?.sessions || [])
    setAgents(res.data?.agents || [])
    setProfiles(res.data?.profiles || [])
    setLoading(false)
  }

  useEffect(() => {
    if (open) void loadList()
  }, [open])

  // Load a thread when one is opened. History comes from Hermes' store, never from
  // local state — two copies of "what was said" would drift.
  useEffect(() => {
    if (!openAgent) {
      setMessages([])
      setSession(null)
      return
    }
    let alive = true
    setLoading(true)
    setErr(null)
    fetchJson<{ session: Session | null; messages?: Message[] }>(
      `/api/hermes/chat?agent=${encodeURIComponent(openAgent)}`,
      { cache: 'no-store' },
    )
      .then((res) => {
        if (!alive) return
        if (!res.ok) {
          setErr(res.error || 'không tải được cuộc trò chuyện')
          return
        }
        setSession(res.data?.session ?? null)
        setMessages(res.data?.messages || [])
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [openAgent])

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  async function send() {
    const text = draft.trim()
    if (!text || !openAgent || busy) return
    setBusy(true)
    setErr(null)
    // Show it immediately: a reply can take many seconds because the agent may run
    // tools, and an input that looks frozen reads as broken.
    setMessages((m) => [...m, { role: 'user', content: text, ts: Date.now() }])
    setDraft('')
    try {
      const res = await fetchJson<{ session: Session; reply: string }>('/api/hermes/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: openAgent, message: text }),
      })
      if (!res.ok || !res.data) {
        setErr(res.error || 'tác tử không phản hồi')
        // Roll the optimistic bubble back so the transcript matches what the agent
        // actually received.
        setMessages((m) => m.slice(0, -1))
        setDraft(text)
        return
      }
      setSession(res.data.session)
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: res.data!.reply || '(trống)', ts: Date.now() },
      ])
      void loadList()
    } finally {
      setBusy(false)
    }
  }

  async function resetThread() {
    if (!openAgent) return
    setBusy(true)
    setErr(null)
    const res = await fetchJson(`/api/hermes/chat?agent=${encodeURIComponent(openAgent)}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      setErr(res.error || 'không xóa được cuộc trò chuyện')
      setBusy(false)
      return
    }
    setMessages([])
    setSession(null)
    setBusy(false)
    void loadList()
  }

  /** Create an agent (a profile) and open its chat straight away. */
  async function createAgent() {
    const name = newName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!name) {
      setErr('tên tác tử chỉ gồm chữ thường, số, - và _')
      return
    }
    setCreateBusy(true)
    setErr(null)
    try {
      const res = await fetchJson<{ name: string }>('/api/hermes/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name }),
      })
      if (!res.ok) {
        setErr(res.error || 'không tạo được tác tử')
        return
      }
      setNewName('')
      setCreating(false)
      onAgentCreated?.()
      await loadList()
      setOpenAgent(name)
    } finally {
      setCreateBusy(false)
    }
  }

  if (!open) return null

  const byAgent = new Map(sessions.map((s) => [s.agent, s]))
  /** Everyone, chatted-with first (newest on top), then the rest alphabetically. */
  const rows = [
    ...sessions.map((s) => s.agent),
    ...agents.filter((a) => !byAgent.has(a)).sort(),
  ]
  const chattable = new Set(profiles)

  return (
    <FullPanel
      onClose={onClose}
      label={openAgent ? `Trò chuyện với ${openAgent}` : 'Trò chuyện'}
      tall
      className="vp-chat"
      bodyClassName="vp-pad flex flex-col gap-3 vp-chat-body"
      title={
        openAgent ? (
          <div className="vp-chat-head">
            <button className="vp-chat-back" onClick={() => setOpenAgent(null)} aria-label="Quay lại">
              ←
            </button>
            <span className="vp-chat-av" style={{ background: `hsl(${hue(openAgent)} 42% 32%)` }}>
              {initials(openAgent)}
            </span>
            <div className="vp-chat-head-name">
              <b>{openAgent}</b>
              <i>{session ? `${session.messageCount} tin nhắn` : 'cuộc trò chuyện mới'}</i>
            </div>
          </div>
        ) : (
          'Trò chuyện'
        )
      }
      actions={
        !openAgent && (
          <button className="vp-chip-btn" onClick={() => setCreating((v) => !v)}>
            + Tác tử
          </button>
        )
      }
    >
      {err && <div className="vp-err">{err}</div>}

      {creating && !openAgent && (
        <div className="vp-chat-new">
          <input
            className="vp-input"
            value={newName}
            autoFocus
            placeholder="tên tác tử (ví dụ: riset, backend)"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createAgent()
            }}
          />
          <button className="vp-btn" disabled={createBusy || !newName.trim()} onClick={createAgent}>
            {createBusy ? '…' : 'Tạo'}
          </button>
          <div className="vp-note">
            Tác tử = hồ sơ Hermes. Mỗi tác tử có bộ nhớ riêng và xuất hiện trong văn phòng
            sau khi được tạo.
          </div>
        </div>
      )}

      {!openAgent ? (
        /* ------------------------------------------------- the chat list -- */
        <>
          {loading && <div className="vp-muted">đang tải…</div>}
          <div className="flex flex-col">
            {rows.map((name) => {
              const s = byAgent.get(name)
              const canChat = chattable.has(name)
              return (
                <button
                  key={name}
                  className="vp-chat-row"
                  onClick={() => setOpenAgent(name)}
                  disabled={!canChat}
                  title={canChat ? '' : 'chưa có hồ sơ'}
                >
                  <span
                    className="vp-chat-av"
                    style={{ background: `hsl(${hue(name)} 42% 32%)` }}
                  >
                    {initials(name)}
                  </span>
                  <span className="vp-chat-row-main">
                    <span className="vp-chat-row-top">
                      <b>{name}</b>
                      <i>{s ? when(s.updatedAt) : ''}</i>
                    </span>
                    <span className="vp-chat-row-sub">
                      {s ? s.title : canChat ? 'bắt đầu trò chuyện' : 'chưa có hồ sơ'}
                    </span>
                  </span>
                </button>
              )
            })}
            {!loading && !rows.length && (
              <div className="vp-muted">
                chưa có tác tử — nhấn <b>+ Tác tử</b> để tạo tác tử
              </div>
            )}
          </div>
        </>
      ) : (
        /* -------------------------------------------------- the conversation -- */
        <>
          <div className="vp-chat-scroll" ref={scroller}>
            {loading && <div className="vp-muted">đang tải lịch sử…</div>}
            {!loading && !messages.length && (
              <div className="vp-chat-empty">
                Bắt đầu trò chuyện với <b>{openAgent}</b>.
                <br />
                <span className="vp-muted">
                  Tin nhắn được lưu trong bộ nhớ của tác tử này và vẫn còn sau khi khởi động lại ứng dụng.
                </span>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`vp-msg ${m.role}`}>
                <div className="vp-msg-body">{m.content}</div>
                <div className="vp-msg-time">{clock(m.ts)}</div>
              </div>
            ))}
            {busy && (
              <div className="vp-msg assistant">
                <div className="vp-msg-body vp-typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>

          <div className="vp-chat-input">
            <textarea
              className="vp-input"
              rows={2}
              value={draft}
              placeholder="Nhập tin nhắn…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button
              className="vp-chat-send"
              disabled={busy || !draft.trim()}
              onClick={send}
              aria-label="Gửi"
            >
              ➤
            </button>
          </div>

          {session && (
            <button className="vp-chat-reset" disabled={busy} onClick={resetThread}>
              Xóa lịch sử cuộc trò chuyện này
            </button>
          )}
        </>
      )}
    </FullPanel>
  )
}
