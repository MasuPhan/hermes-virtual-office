'use client'

import { useEffect, useState } from 'react'
import { useOffice } from '@/lib/store'
import Collapsible from './Collapsible'
import { uiState } from './UiLabels'
import FullPanel from './FullPanel'
import ActionItems, { type Candidate } from './ActionItems'
import { fetchJson } from '@/lib/api'

/**
 * Meeting room.
 *
 * Two screens: a LIST of meeting cards and the CREATE form.
 *
 * Every meeting is a CARD, including the one running right now. Nothing expands
 * inline — a live meeting used to render its whole transcript straight into the
 * list, so the list was dominated by the newest meeting and the older ones were
 * pushed off screen. A card opens on click, live or archived.
 */
export default function MeetingPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const agents = useOffice((s) => s.agents)
  const meeting = useOffice((s) => s.meeting)
  const configured = useOffice((s) => s.meetingConfigured)
  const history = useOffice((s) => s.meetingHistory)
  const refresh = useOffice((s) => s.refreshMeeting)

  const [screen, setScreen] = useState<'list' | 'new'>('list')
  const [topic, setTopic] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [moderator, setModerator] = useState('')
  const [meetingMode, setMeetingMode] = useState<'simulasi' | 'a2a'>('simulasi')
  const [busy, setBusy] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  /**
   * Which card is open. A live meeting reads from its in-memory record; an
   * archived one is fetched by id. `kind` decides which.
   */
  const [opened, setOpened] = useState<{ kind: 'live' | 'archive'; id: string } | null>(null)
  const [archive, setArchive] = useState<{ id: string; body: string } | null>(null)
  const [archBusy, setArchBusy] = useState(false)

  /**
   * Follow-up items parsed from the open meeting's minutes, offered as tasks.
   * Loaded per opened meeting, including archived ones — a follow-up from last
   * week's meeting is exactly the thing that still needs doing.
   */
  const [items, setItems] = useState<Candidate[]>([])
  const [roster, setRoster] = useState<string[]>([])
  const [itemsBusy, setItemsBusy] = useState(false)

  // Load the follow-ups whenever an open card has minutes to read from. A meeting
  // that is still running has none yet, so this fires on completion.
  const openId = opened?.id || ''
  const minutesReady = opened
    ? opened.kind === 'live'
      ? !!meeting?.minutes
      : !!archive?.body
    : false
  useEffect(() => {
    if (!openId || !minutesReady) {
      setItems([])
      return
    }
    let alive = true
    setItemsBusy(true)
    fetchJson<{ items?: Candidate[]; roster?: string[] }>(
      `/api/hermes/meeting/actions?from=${encodeURIComponent(openId)}`,
      { cache: 'no-store' },
    )
      .then((res) => {
        if (!alive) return
        // A meeting with no follow-ups is a normal outcome, not an error: the panel
        // simply shows nothing to convert.
        setItems(res.ok ? res.data?.items || [] : [])
        setRoster(res.data?.roster || [])
      })
      .finally(() => alive && setItemsBusy(false))
    return () => {
      alive = false
    }
  }, [openId, minutesReady])

  if (!open) return null

  const live = meeting && (meeting.state === 'queued' || meeting.state === 'running')

  const toggle = (name: string) => {
    setPicked((p) => {
      if (p.includes(name)) {
        const next = p.filter((x) => x !== name)
        if (moderator === name) setModerator(next[0] || '')
        return next
      }
      if (p.length >= 4) return p
      const next = [...p, name]
      if (!moderator) setModerator(name)
      return next
    })
  }

  async function start() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetchJson('/api/hermes/meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, participants: picked, moderator, mode: meetingMode }),
      })
      if (!res.ok) throw new Error(res.error || 'không bắt đầu được cuộc họp')
      await refresh()
      setTopic('')
      setPicked([])
      setModerator('')
      setScreen('list')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function openArchive(id: string) {
    setArchBusy(true)
    setErr(null)
    setOpened({ kind: 'archive', id })
    setArchive(null)
    try {
      const res = await fetchJson<{ id: string; body: string }>(
        `/api/hermes/meeting?id=${encodeURIComponent(id)}`,
        { cache: 'no-store' },
      )
      if (!res.ok || !res.data) throw new Error(res.error || 'không mở được bản ghi hội thoại')
      setArchive({ id: res.data.id, body: res.data.body })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setArchBusy(false)
    }
  }

  function closeCard() {
    setOpened(null)
    setArchive(null)
  }

  /**
   * Batalkan rapat yang sedang berjalan (RAPAT-CANCEL-1). Tombolnya hanya
   * dirender saat `live` — tak ada rapat berjalan = tak ada tombol, tak ada
   * sukses palsu. Arsip DIBATALKAN ditulis runner di batas giliran; refresh
   * berkala mengambil status terbaru.
   */
  async function cancel() {
    if (!meeting) return
    setCancelBusy(true)
    setErr(null)
    try {
      const res = await fetchJson<{ already_cancelled?: boolean; cancel_requested?: boolean }>(
        '/api/hermes/meeting/cancel',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: meeting.id }),
        },
      )
      if (!res.ok) throw new Error(res.error || 'không hủy được cuộc họp')
      await refresh()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setCancelBusy(false)
    }
  }

  function download(name: string, text: string) {
    const blob = new Blob([text], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  /** One card in the list. */
  function Card({
    title,
    meta,
    highlight,
    onClick,
    disabled,
  }: {
    title: string
    meta: string
    highlight?: boolean
    onClick: () => void
    disabled?: boolean
  }) {
    return (
      <button
        className={`vp-meeting-row ${highlight ? 'on' : ''}`}
        onClick={onClick}
        disabled={disabled}
      >
        <b>{title}</b>
        <i>{meta}</i>
      </button>
    )
  }

  return (
    <FullPanel
      onClose={onClose}
      label="Phòng họp"
      title={screen === 'new' ? 'Cuộc họp mới' : 'Phòng họp'}
      actions={
        screen === 'new' && (
          <button className="vp-chip-btn" onClick={() => setScreen('list')}>
            ← Quay lại
          </button>
        )
      }
      bodyClassName="vp-pad flex flex-col gap-3"
    >
      {err && <div className="vp-err">{err}</div>}

      {screen === 'list' ? (
        opened ? (
          /* ------------------------------------------------ opened card ---- */
          <>
            <button className="vp-chip-btn" onClick={closeCard}>
              ← Danh sách cuộc họp
            </button>

            {opened.kind === 'archive' ? (
              archBusy || !archive ? (
                <div className="vp-muted">đang tải bản ghi hội thoại…</div>
              ) : (
                <>
                  <Collapsible
                    label={`Bản ghi hội thoại · ${archive.id}`}
                    text={archive.body}
                    defaultOpen
                  />
                  <button
                    className="vp-btn vp-btn-ghost"
                    onClick={() => download(`rapat-${archive.id}.md`, archive.body)}
                  >
                    Tải xuống
                  </button>

                  {itemsBusy ? (
                    <div className="vp-muted">đang đọc việc cần theo dõi…</div>
                  ) : (
                    <ActionItems
                      candidates={items}
                      roster={roster}
                      origin={{ kind: 'meeting', ref: archive.id }}
                      label="VIỆC THEO DÕI → CÔNG VIỆC"
                    />
                  )}
                </>
              )
            ) : !meeting ? (
              <div className="vp-muted">cuộc họp này không còn trong bộ nhớ</div>
            ) : (
              <>
                <div className="vp-kv">
                  <span>chủ đề</span>
                  <b>{meeting.topic || '(chưa có chủ đề)'}</b>
                </div>
                <div className="vp-kv">
                  <span>trạng thái</span>
                  <b>
                    {uiState(meeting.state)} · {uiState(meeting.phase)}
                    {live && <span className="vp-live"> ●</span>}
                  </b>
                </div>
                <div className="vp-kv">
                  <span>chế độ</span>
                  <b>
                    {meeting.mode === 'a2a'
                      ? 'A2A — phát biểu của tác tử thực qua A2A'
                      : 'mô phỏng — LLM của gateway phát biểu, KHÔNG PHẢI tác tử'}
                  </b>
                </div>
                <div className="vp-kv">
                  <span>người tham gia</span>
                  <b>{meeting.participants.join(', ') || '—'}</b>
                </div>
                <div className="vp-kv">
                  <span>lượt phát biểu</span>
                  <b>{meeting.currentSpeaker || '—'}</b>
                </div>

                {live && (
                  <button
                    className="vp-btn vp-btn-warn"
                    disabled={cancelBusy}
                    onClick={cancel}
                  >
                    {cancelBusy ? 'Đang hủy…' : 'Hủy cuộc họp'}
                  </button>
                )}

                <Collapsible
                  label="Bản ghi hội thoại"
                  count={meeting.turns.length}
                  defaultOpen={!!live}
                  empty="chưa có lượt phát biểu"
                >
                  <div className="flex flex-col gap-2">
                    {meeting.turns.map((t, i) => (
                      <div
                        key={i}
                        className={`vp-turn ${
                          t.speaker === meeting.currentSpeaker && live ? 'talk' : ''
                        }`}
                      >
                        <div className="vp-turn-who">
                          {t.speaker}
                          <i>
                            {uiState(t.kind)}
                            {t.round ? ` · vòng ${t.round}` : ''}
                          </i>
                        </div>
                        <div className="vp-turn-body">{t.text}</div>
                      </div>
                    ))}
                  </div>
                </Collapsible>

                {meeting.minutes && (
                  <>
                    <Collapsible label="Biên bản" text={meeting.minutes} defaultOpen />
                    <button
                      className="vp-btn vp-btn-ghost"
                      onClick={() => download(`notulen-${meeting.id}.md`, meeting.minutes)}
                    >
                      Tải biên bản
                    </button>

                    {/* The cross-menu link: what this meeting asked for, as tasks. */}
                    {itemsBusy ? (
                      <div className="vp-muted">đang đọc việc cần theo dõi…</div>
                    ) : (
                      <ActionItems
                        candidates={items}
                        roster={roster}
                        origin={{ kind: 'meeting', ref: meeting.id }}
                        label="VIỆC THEO DÕI → CÔNG VIỆC"
                      />
                    )}
                  </>
                )}
              </>
            )}
          </>
        ) : (
          /* ------------------------------------------------ the list ------ */
          <>
            <button className="vp-btn" onClick={() => setScreen('new')}>
              + Tạo cuộc họp mới
            </button>
            {!configured && (
              <div className="vp-note">
                Chưa cấu hình LLM — chưa thể bắt đầu họp. Điền{' '}
                <code>AI_BASE_URL</code> và <code>AI_API_KEY</code> trong{' '}
                <code>.env.local</code>.
              </div>
            )}

            {meeting && (
              <>
                <div className="vp-sub">
                  CUỘC HỌP HIỆN TẠI {live && <span className="vp-live">●</span>}
                </div>
                <Card
                  title={meeting.topic || '(chưa có chủ đề)'}
                  meta={`${uiState(meeting.state)} · ${meeting.participants.length} người tham gia · ${meeting.turns.length} lượt phát biểu`}
                  highlight={!!live}
                  onClick={() => setOpened({ kind: 'live', id: meeting.id })}
                />
              </>
            )}

            <div className="vp-sub">CUỘC HỌP TRƯỚC ({history.length})</div>
            <div className="flex flex-col gap-2">
              {history.map((h) => (
                <Card
                  key={h.id}
                  title={h.topic}
                  meta={`${new Date(h.startedAt).toLocaleDateString('vi-VN')} · ${h.participants.length || '?'} người tham gia · ${h.turnCount} lượt phát biểu`}
                  disabled={archBusy}
                  onClick={() => openArchive(h.id)}
                />
              ))}
              {!history.length && (
                <span className="vp-muted">chưa có cuộc họp được lưu</span>
              )}
            </div>
          </>
        )
      ) : (
        /* ---------------------------------------------------- create form -- */
        <>
          <label className="vp-sub">CHỦ ĐỀ</label>
          <textarea
            className="vp-input"
            rows={2}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Kế hoạch phát hành API hoàn tiền"
          />

          <label className="vp-sub">NGƯỜI THAM GIA (2–4) · {agents.length} tác tử đang hoạt động</label>
          <div className="flex flex-wrap gap-2">
            {agents.map((a) => (
              <button
                key={a.name}
                className={`vp-chip-btn ${picked.includes(a.name) ? 'on' : ''}`}
                onClick={() => toggle(a.name)}
              >
                {a.displayName}
                <i className="vp-chip-role">{uiState(a.status)}</i>
              </button>
            ))}
            {!agents.length && <span className="vp-muted">chưa có tác tử đang hoạt động</span>}
          </div>

          <label className="vp-sub">NGƯỜI ĐIỀU PHỐI</label>
          <select
            className="vp-input"
            value={moderator}
            onChange={(e) => setModerator(e.target.value)}
          >
            {picked.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <label className="vp-sub">CHẾ ĐỘ HỌP</label>
          <div className="flex flex-col gap-2">
            <label className="vp-kv">
              <input
                type="radio"
                name="meeting-mode"
                checked={meetingMode === 'simulasi'}
                onChange={() => setMeetingMode('simulasi')}
              />
              <span>
                <b>Mô phỏng</b> — LLM của gateway phát biểu, <b>không phải</b> tác tử. Cách hoạt động cũ,
                được ghi rõ để tránh nhầm lẫn.
              </span>
            </label>
            <label className="vp-kv">
              <input
                type="radio"
                name="meeting-mode"
                checked={meetingMode === 'a2a'}
                onChange={() => setMeetingMode('a2a')}
              />
              <span>
                <b>A2A</b> — tác tử thực phát biểu qua giao thức A2A (cần bật A2A cho từng
                người tham gia + khởi động lại gateway sau khi thay đổi).
              </span>
            </label>
          </div>

          <button
            className="vp-btn"
            disabled={busy || !topic.trim() || picked.length < 2 || !configured}
            onClick={start}
          >
            {busy ? 'Đang bắt đầu…' : 'Bắt đầu họp'}
          </button>
          {picked.length < 2 && <div className="vp-muted">chọn ít nhất 2 người tham gia</div>}
        </>
      )}
    </FullPanel>
  )
}
