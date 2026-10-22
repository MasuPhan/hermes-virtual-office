'use client'

import { useEffect, useState } from 'react'
import Collapsible from './Collapsible'
import { uiState } from './UiLabels'
import ActionItems from './ActionItems'
import FullPanel from './FullPanel'
import type { Candidate } from '@/types/hermes'
import { fetchJson } from '@/lib/api'

/**
 * Cron job management.
 *
 * Two safety rules, both deliberate:
 *
 *   1. A new job is created PAUSED. A job created live can fire before anyone has
 *      read it back, and the schedule syntax is easy to get wrong. There is an
 *      explicit "langsung aktif" checkbox for when that is what you want.
 *   2. Every action that changes a schedule needs a SECOND click. The button
 *      turns into "Yakin?" in place, and clicking elsewhere cancels. A single
 *      stray click must not pause the job that keeps something alive.
 */

type Job = {
  id: string
  name: string
  prompt: string
  schedule: string
  scheduleKind: string
  enabled: boolean
  state: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
  failureStreak: number
  deliver: string
  noAgent: boolean
  script: string | null
  skills: string[]
  repeatTimes: number | null
  repeatCompleted: number
}

type Run = {
  id: string
  jobId: string
  status: string
  source: string
  startedAt: string | null
  finishedAt: string | null
}

/** Human-readable relative time, or the raw value if it cannot be parsed. */
function when(iso: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diff = t - Date.now()
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60_000)
  const label =
    abs < 60_000
      ? 'bây giờ'
      : mins < 60
        ? `${mins} phút`
        : abs < 86_400_000
          ? `${Math.round(mins / 60)} giờ`
          : `${Math.round(abs / 86_400_000)} ngày`
  return diff >= 0 ? `sau ${label}` : `${label} trước`
}

export default function CronPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  /** jobs.json gagal dibaca/parse — tampilkan "tak terbaca", BUKAN "tidak ada job". */
  const [jobsFailure, setJobsFailure] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [screen, setScreen] = useState<'list' | 'new'>('list')
  /**
   * Follow-up candidates per job id. Loaded lazily when the user asks for them —
   * most jobs are healthy and have nothing to hand over, so this is not fetched
   * for every row on every poll.
   */
  const [items, setItems] = useState<Record<string, Candidate[]>>({})
  const [roster, setRoster] = useState<string[]>([])
  const [itemsBusy, setItemsBusy] = useState<string | null>(null)

  /** id + action awaiting the second click. */
  const [confirm, setConfirm] = useState<{ id: string; action: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // create form
  const [schedule, setSchedule] = useState('')
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [liveNow, setLiveNow] = useState(false)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchJson<{ jobs?: Job[]; runs?: Run[]; jobsFailure?: string }>(
        '/api/hermes/cron',
        {
          cache: 'no-store',
        },
      )
      if (!res.ok) throw new Error(res.error || 'không tải được lịch định kỳ')
      setJobs(res.data?.jobs || [])
      setRuns(res.data?.runs || [])
      setJobsFailure(res.data?.jobsFailure || null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load()
  }, [open])

  // A click anywhere else cancels a pending confirmation.
  useEffect(() => {
    if (!confirm) return
    const cancel = () => setConfirm(null)
    window.addEventListener('click', cancel)
    return () => window.removeEventListener('click', cancel)
  }, [confirm])

  async function act(id: string, action: string) {
    setBusy(id + action)
    setErr(null)
    setNote(null)
    try {
      const res = await fetchJson('/api/hermes/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      })
      if (!res.ok) throw new Error(res.error || 'thao tác thất bại')
      setNote(
        action === 'remove'
          ? 'đã xóa lịch chạy'
          : action === 'run'
            ? 'lịch sẽ chạy ở nhịp xử lý tiếp theo'
            : `lịch chạy ${action === 'pause' ? 'đã tạm dừng' : 'đã bật'}`,
      )
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  /** Fetch a job's follow-up candidates. */
  async function loadItems(jobId: string) {
    setItemsBusy(jobId)
    setErr(null)
    try {
      const res = await fetchJson<{ items?: Candidate[]; roster?: string[] }>(
        `/api/hermes/cron/actions?from=${encodeURIComponent(jobId)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(res.error || 'không đọc được việc cần theo dõi')
      setItems((prev) => ({ ...prev, [jobId]: res.data?.items || [] }))
      setRoster(res.data?.roster || [])
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setItemsBusy(null)
    }
  }

  async function create() {
    setBusy('create')
    setErr(null)
    setNote(null)
    try {
      const res = await fetchJson<{ id: string }>('/api/hermes/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          schedule,
          prompt,
          name,
          paused: !liveNow,
        }),
      })
      if (!res.ok || !res.data) throw new Error(res.error || 'không tạo được lịch chạy')
      const newId = res.data.id
      setNote(
        liveNow
          ? `đã tạo và bật lịch chạy ngay (${newId})`
          : `đã tạo lịch chạy ở trạng thái tạm dừng (${newId}) — kiểm tra rồi bật khi đã đúng`,
      )
      setSchedule('')
      setPrompt('')
      setName('')
      setLiveNow(false)
      await load()
      setScreen('list')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (!open) return null

  /** A button that needs a second click before it fires. */
  function Guarded({
    id,
    action,
    label,
    confirmLabel,
    className,
  }: {
    id: string
    action: string
    label: string
    confirmLabel: string
    className?: string
  }) {
    const armed = confirm?.id === id && confirm.action === action
    return (
      <button
        className={`vp-btn ${className || ''}`}
        disabled={busy === id + action}
        onClick={(e) => {
          e.stopPropagation()
          if (!armed) {
            setConfirm({ id, action })
            return
          }
          void act(id, action)
        }}
      >
        {busy === id + action ? '…' : armed ? confirmLabel : label}
      </button>
    )
  }

  return (
    <FullPanel
      onClose={onClose}
      label="Lịch định kỳ"
      title={screen === 'new' ? 'Lịch chạy mới' : 'Lịch định kỳ'}
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
      {note && <div className="vp-ok">{note}</div>}
      {loading && <div className="vp-muted">đang tải…</div>}
      {/* jobs.json gagal dibaca = "tak terbaca", BUKAN "belum ada job" — pola jujur (bedakan baca-gagal dari kosong). */}
      {jobsFailure && <div className="vp-err">không đọc được lịch (không có nghĩa là &quot;chưa có lịch chạy&quot;): {jobsFailure}</div>}

      {screen === 'list' ? (
        <>
          <button className="vp-btn" onClick={() => setScreen('new')}>
            + Tạo lịch chạy
          </button>
          <button className="vp-btn vp-btn-rosy" disabled={loading} onClick={load}>
            Làm mới
          </button>

          <div className="vp-sub">LỊCH CHẠY ({jobs.length})</div>
          <div className="flex flex-col gap-2">
            {jobs.map((j) => (
              <div key={j.id} className={`vp-cron-card ${j.enabled ? 'on' : ''}`}>
                <div className="vp-cron-top">
                  <b>{j.name}</b>
                  <span className={`vp-cron-state ${j.enabled ? 'on' : 'off'}`}>{uiState(j.state)}</span>
                </div>
                <i className="vp-cron-sched">{j.schedule}</i>
                <div className="vp-cron-meta">
                  <span>{j.enabled ? `chạy ${when(j.nextRunAt)}` : 'tạm dừng'}</span>
                  {j.lastRunAt && <span>lần cuối {when(j.lastRunAt)}</span>}
                  {j.failureStreak > 0 && (
                    <span className="vp-cron-bad">thất bại {j.failureStreak}×</span>
                  )}
                </div>
                {j.prompt && <Collapsible label="Chỉ dẫn" text={j.prompt} />}
                {j.lastError && <div className="vp-cron-err">{j.lastError}</div>}

                {/* The cross-menu link: a failing job becomes a task. Offered only
                    when there is something to fix, so a healthy job stays quiet. */}
                {j.failureStreak > 0 && (
                  <>
                    {items[j.id] ? (
                      <ActionItems
                        candidates={items[j.id]}
                        roster={roster}
                        origin={{ kind: 'cron', ref: j.id }}
                        label="VIỆC THEO DÕI → CÔNG VIỆC"
                      />
                    ) : (
                      <button
                        className="vp-btn vp-btn-ghost"
                        disabled={itemsBusy === j.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          void loadItems(j.id)
                        }}
                      >
                        {itemsBusy === j.id ? '…' : 'Tạo công việc từ lỗi này'}
                      </button>
                    )}
                  </>
                )}
                <div className="vp-cron-actions">
                  {j.enabled ? (
                    <Guarded
                      id={j.id}
                      action="pause"
                      label="Tạm dừng"
                      confirmLabel="Xác nhận tạm dừng?"
                    />
                  ) : (
                    <Guarded
                      id={j.id}
                      action="resume"
                      label="Bật"
                      confirmLabel="Xác nhận bật?"
                    />
                  )}
                  <Guarded
                    id={j.id}
                    action="run"
                    label="Chạy"
                    confirmLabel="Xác nhận chạy?"
                  />
                  <Guarded
                    id={j.id}
                    action="remove"
                    label="Xóa"
                    confirmLabel="Xác nhận xóa?"
                    className="vp-btn-danger"
                  />
                </div>
              </div>
            ))}
            {!jobs.length && !jobsFailure && <span className="vp-muted">chưa có lịch chạy định kỳ</span>}
          </div>

          {runs.length > 0 && (
            <>
              <div className="vp-sub">LẦN CHẠY GẦN ĐÂY ({runs.length})</div>
              <div className="flex flex-col gap-1">
                {runs.slice(0, 12).map((r) => (
                  <div key={r.id} className="vp-cron-run">
                    {/* Hermes reports a good run as `completed`, not `success`;
                        matching only `success` painted every green run grey. */}
                    <span className={`vp-cron-state ${['success', 'completed'].includes(r.status) ? 'on' : 'off'}`}>
                      {uiState(r.status)}
                    </span>
                    <i>{r.jobId}</i>
                    <span>{when(r.startedAt)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <label className="vp-sub">LỊCH CHẠY</label>
          <input
            className="vp-input"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            placeholder="30m  ·  every 2h  ·  0 9 * * *"
          />

          <label className="vp-sub">CHỈ DẪN</label>
          <textarea
            className="vp-input"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="nhập chỉ dẫn"
          />

          <label className="vp-sub">TÊN (không bắt buộc)</label>
          <input
            className="vp-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="kiểm tra bản phát hành hằng ngày"
          />

          <label className="vp-check">
            <input
              type="checkbox"
              checked={liveNow}
              onChange={(e) => setLiveNow(e.target.checked)}
            />
            <span>bật ngay (nếu không chọn, lịch chạy được tạo ở trạng thái tạm dừng)</span>
          </label>

          <button
            className="vp-btn"
            disabled={busy === 'create' || !schedule.trim() || !prompt.trim()}
            onClick={create}
          >
            {busy === 'create' ? 'Đang tạo…' : 'Tạo lịch chạy'}
          </button>
        </>
      )}
    </FullPanel>
  )
}
