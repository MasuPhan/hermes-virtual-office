'use client'

import { useEffect, useState } from 'react'
import { useOffice } from '@/lib/store'
import Collapsible from './Collapsible'
import { UI_ROLE_LABEL, uiState } from './UiLabels'
import ModelPicker, { type ModelChoice } from './ModelPicker'
import type { Task } from '@/types/hermes'
import { fetchJson } from '@/lib/api'
import { t as translate } from '@/lib/i18n'
import type { EvidenceItem, EvidenceVerdict } from '@/lib/hermes/evidence'
import type { VerificationReading } from '@/lib/hermes/verification'

type RunInfo = {
  id: number
  profile: string
  status: string
  outcome?: string | null
  summary?: string | null
  error?: string | null
}

/** Bentuk GET /api/hermes/tasks/{id}/verification (TaskVerification di lib/hermes/kanban.ts). */
type Verification = VerificationReading & {
  readAt: string
}

/** Bentuk GET /api/hermes/tasks/{id}/evidence (TaskEvidence di lib/hermes/kanban.ts). */
type Evidence = {
  verdict: EvidenceVerdict
  items: EvidenceItem[]
  completedAt?: string
  completedAgeSeconds: number | null
  readAt: string
}

function age(sec: number | null): string {
  if (sec == null || sec < 0) return '—'
  if (sec < 60) return `${sec} giây`
  if (sec < 3600) return `${Math.floor(sec / 60)} phút`
  if (sec < 86400) return `${Math.floor(sec / 3600)} giờ`
  return `${Math.floor(sec / 86400)} ngày`
}

/**
 * How an origin reads in the panel.
 *
 * Returns null for anything that is not a cross-menu link. The CLI writes
 * `created_by` itself for ordinary tasks ('worker', 'user'), and showing "asal:
 * worker" on every task is noise — the line only earns its space when it names the
 * meeting or job the work came from.
 */
function originLabel(o?: { kind: string; ref?: string }): string | null {
  if (!o) return null
  switch (o.kind) {
    case 'meeting':
      return o.ref ? `cuộc họp ${o.ref}` : 'cuộc họp'
    case 'cron':
      return o.ref ? `lịch định kỳ ${o.ref}` : 'lịch định kỳ'
    case 'agent':
      return o.ref ? `tác tử ${o.ref}` : 'tác tử'
    default:
      return null
  }
}

const STATUS_LABEL: Record<string, string> = {
  todo: 'Chưa thực hiện',
  triage: 'Cần làm rõ yêu cầu',
  ready: 'Sẵn sàng để tiến trình nhận',
  scheduled: 'Đã lên lịch',
  running: 'Đang thực hiện',
  review: 'Chờ đánh giá',
  blocked: 'Bị chặn',
  done: 'Hoàn tất (theo báo cáo của tiến trình)',
  archived: 'Đã lưu trữ',
}

/**
 * Task detail panel. Opened from a card on the 3D wall board or from the 2D
 * board — including tasks that are already `done`, which is why it reads the
 * run history rather than live output only.
 */
export default function TaskPanel() {
  const taskId = useOffice((s) => s.openTaskId)
  const openTask = useOffice((s) => s.openTask)
  const tasks = useOffice((s) => s.tasks)
  const agents = useOffice((s) => s.agents)
  const load = useOffice((s) => s.load)

  const [runs, setRuns] = useState<RunInfo[]>([])
  /** The same task as `/tasks/{id}` reports it — `list` has no dependency edges. */
  const [detail, setDetail] = useState<Task | null>(null)
  const [log, setLog] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [models, setModels] = useState<ModelChoice[]>([])
  const [pick, setPick] = useState('')
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [evErr, setEvErr] = useState<string | null>(null)
  const [evBusy, setEvBusy] = useState(false)
  const [evNonce, setEvNonce] = useState(0)
  const [verify, setVerify] = useState<Verification | null>(null)
  const [vfErr, setVfErr] = useState<string | null>(null)
  const [vfBusy, setVfBusy] = useState(false)

  // `detail` first: it is the only payload with `parents`.
  const task: Task | undefined = detail?.id === taskId ? detail : tasks.find((t) => t.id === taskId)
  const agent = agents.find((a) => a.name === task?.assignee)

  useEffect(() => {
    if (!taskId) return
    let alive = true
    setLoading(true)
    setErr(null)
    fetchJson<{ runs?: RunInfo[]; log?: string; task?: Task }>(`/api/hermes/tasks/${taskId}`, {
      cache: 'no-store',
    })
      .then((res) => {
        if (!alive) return
        if (!res.ok) {
          setErr(res.error || 'không tải được chi tiết công việc')
          return
        }
        setRuns(res.data?.runs || [])
        setLog(res.data?.log || '')
        setDetail(res.data?.task || null)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [taskId])

  // Bukti hasil kerja: dibaca terpisah (show + runs + log + lampiran). Gagal = "gagal membaca
  // bukti", dan bukti task sebelumnya dibuang — tidak pernah dipajang sebagai bukti task ini.
  useEffect(() => {
    if (!taskId) return
    let alive = true
    setEvidence(null)
    setEvErr(null)
    setEvBusy(true)
    fetchJson<Evidence>(`/api/hermes/tasks/${taskId}/evidence`, { cache: 'no-store' })
      .then((res) => {
        if (!alive) return
        if (!res.ok || !res.data || !Array.isArray(res.data.items)) {
          setEvErr(res.error || 'không đọc được bằng chứng')
          return
        }
        setEvidence(res.data)
      })
      .finally(() => alive && setEvBusy(false))
    return () => {
      alive = false
    }
  }, [taskId, evNonce])

  // Verifikasi independen: klaim worker vs review. Dibaca terpisah dari jejak events.
  // Hanya untuk done/review — task lain tidak dinilai. Gagal = "gagal membaca verifikasi",
  // dan hasil task sebelumnya dibuang — tidak pernah dipajang sebagai hasil task ini.
  useEffect(() => {
    if (!taskId) return
    let alive = true
    setVerify(null)
    setVfErr(null)
    setVfBusy(true)
    fetchJson<Verification>(`/api/hermes/tasks/${taskId}/verification`, { cache: 'no-store' })
      .then((res) => {
        if (!alive) return
        if (!res.ok || !res.data || typeof res.data.verdict !== 'string') {
          setVfErr(res.error || 'không đọc được kết quả xác minh')
          return
        }
        setVerify(res.data)
      })
      .finally(() => alive && setVfBusy(false))
    return () => {
      alive = false
    }
  }, [taskId])

  // The model list is config, not board state: fetched once per panel, not on the
  // poll, so opening a task does not spawn a CLI read every 4 seconds.
  useEffect(() => {
    if (!taskId || models.length) return
    let alive = true
    fetchJson<{ models?: ModelChoice[] }>('/api/hermes/models', { cache: 'no-store' }).then((res) => {
      if (alive && res.ok) setModels(res.data?.models || [])
    })
    return () => {
      alive = false
    }
  }, [taskId, models.length])

  // Show what the task is actually pinned to, not a stale pick from another task.
  useEffect(() => {
    setPick(task?.model || '')
    setNote(null)
  }, [taskId, task?.model])

  // Drawer: Esc closes it (and clears ?task= in the URL via openTask).
  useEffect(() => {
    if (!taskId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input,textarea,select')) openTask(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [taskId, openTask])

  if (!taskId) return null

  /** promote | set-model ('run' is disabled server-side, see A4 note below) */
  async function act(action: 'promote' | 'set-model', extra: Record<string, unknown> = {}) {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetchJson<{ note?: string; mine?: boolean }>(
        `/api/hermes/tasks/${taskId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...extra }),
        },
      )
      if (!res.ok) throw new Error(res.error || 'thao tác thất bại')
      setNote(res.data?.note || (action === 'set-model' ? 'Đã lưu mô hình.' : 'Hoàn tất.'))
      await load()
      const fresh = await fetchJson<{ runs?: RunInfo[]; log?: string; task?: Task }>(
        `/api/hermes/tasks/${taskId}`,
        { cache: 'no-store' },
      )
      if (fresh.ok) {
        setRuns(fresh.data?.runs || [])
        setLog(fresh.data?.log || '')
        setDetail(fresh.data?.task || null)
      }
      setEvNonce((n) => n + 1)
    } catch (e) {
      setNote(`Thất bại: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const blocked = task?.status === 'blocked' || task?.status === 'scheduled'

  return (
    <aside className="vp-panel vp-drawer right-0" aria-label="Chi tiết công việc">
      <header className="vp-panel-head">
        <h2>Chi tiết công việc</h2>
        <button className="vp-x" onClick={() => openTask(null)} aria-label="Đóng">
          ×
        </button>
      </header>

      <div className="vp-pad flex flex-col gap-3">
        {!task && <div className="vp-muted">Công việc {taskId} không có trên bảng hiện tại.</div>}

        {task && (
          <>
            <div className="vp-kv">
              <span>tiêu đề</span>
              <b>{task.title}</b>
            </div>
            <div className="vp-kv">
              <span>trạng thái</span>
              <b>{STATUS_LABEL[task.status] || task.status}</b>
            </div>
            <div className="vp-kv">
              <span>người phụ trách</span>
              <b>{task.assignee || '—'}{agent ? ` (${UI_ROLE_LABEL[agent.role] ?? agent.role})` : ''}</b>
            </div>
            <div className="vp-kv">
              <span>độ ưu tiên</span>
              <b>{task.priority}</b>
            </div>
            <div className="vp-kv">
              <span>mô hình của tiến trình</span>
              <b>{task.model || 'mặc định của hồ sơ'}</b>
            </div>
            {task.updatedAt && (
              <div className="vp-kv">
                <span>cập nhật</span>
                <b>{new Date(task.updatedAt).toLocaleString('vi-VN')}</b>
              </div>
            )}
            {originLabel(task.origin) && (
              <div className="vp-kv">
                <span>nguồn</span>
                <b>{originLabel(task.origin)}</b>
              </div>
            )}
            <code className="vp-code-block">{task.id}</code>

            {/* The board's own dependency edge. A parent parks its subtasks: the
                dispatcher will not spawn them until every parent is `done`, and
                "menunggu prasyarat" without the ids is unactionable. */}
            {!!task.parents?.length && (
              <>
                <div className="vp-sub">ĐIỀU KIỆN TIÊN QUYẾT ({task.parents.length})</div>
                <div className="flex flex-col gap-1">
                  {task.parents.map((id) => {
                    const parent = tasks.find((t) => t.id === id)
                    const state = parent?.status
                    const clear = state === 'done' || state === 'archived'
                    return (
                      <button
                        key={id}
                        className="vp-run text-left"
                        onClick={() => openTask(id)}
                        title="Mở công việc này"
                      >
                        <b className={clear ? '' : 'vp-warn'}>{clear ? 'hoàn tất' : STATUS_LABEL[state || ''] || state || 'không có trên bảng'}</b>
                        <span className="vp-muted"> · {parent?.title || id}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="vp-muted">
                  {translate('Kanban.parentsNote')}
                </div>
              </>
            )}

            {/* A4: "Chạy" used to POST action=run, which the server refuses (HVO-05): Hermes
                only has `dispatch`, and that runs a pass over the WHOLE board — it cannot
                target this card, so the office never fires it. The button stays visible
                but disabled, with the reason, instead of a click that fails with 501.
                Lifting a parked card (promote/unblock) is a sanctioned single-card write and
                is offered behind a confirm. */}
            <div className="vp-sub">{translate('Kanban.runHeading')}</div>
            <div className="flex flex-wrap gap-2">
              <button
                className="vp-btn"
                disabled
                aria-disabled="true"
                aria-describedby="vp-run-why"
                title={translate('Kanban.runDisabledWhy')}
              >
                {translate('Kanban.runDisabled')}
              </button>
              {blocked && (
                <button
                  className="vp-btn"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(translate('Kanban.unblockConfirm', { title: task.title }))) void act('promote')
                  }}
                >
                  {busy ? '…' : translate('Kanban.unblock')}
                </button>
              )}
            </div>
            <div id="vp-run-why" className="vp-muted">{translate('Kanban.runDisabledWhy')}</div>

            <div className="vp-sub">MÔ HÌNH TÁC TỬ CHO VIỆC NÀY</div>
            <ModelPicker
              value={pick}
              onChange={setPick}
              models={models}
              emptyLabel={`mặc định của hồ sơ${agent ? ` (${agent.name})` : ''}`}
              disabled={busy}
              title="Áp dụng cho lần khởi tạo tiến trình tiếp theo"
            />
            <div className="flex gap-2">
              <button
                className="vp-btn"
                disabled={busy || pick === (task.model || '')}
                onClick={() => {
                  const hit = models.find((m) => m.model === pick)
                  void act('set-model', pick ? { model: pick, provider: hit?.provider } : { model: null })
                }}
                title="Áp dụng cho lần khởi tạo tiến trình tiếp theo"
              >
                Lưu mô hình
              </button>
            </div>
            {note && <div className="vp-note">{note}</div>}

            {task.body && <Collapsible label="Mô tả" text={task.body} />}

            {/* Klaim worker ≠ terverifikasi. "Selesai" hanya berarti worker MENYATAKAN
                selesai; terverifikasi berarti ada jejak review_requested → completed dari
                tangan kedua yang independen. Basi/gagal dibaca = dikatakan apa adanya. */}
            <div className="vp-sub">XÁC MINH</div>
            {vfBusy && <div className="vp-muted">đang đọc kết quả xác minh…</div>}
            {vfErr && <div className="vp-err">không đọc được kết quả xác minh: {vfErr}</div>}
            {verify && (
              <>
                <div className="vp-kv">
                  <span>trạng thái</span>
                  {verify.verdict === 'verified' ? (
                    <b>
                      <span className="vp-chip">đã xác minh</span>
                      {verify.reviewer && <span className="vp-muted"> · bởi {verify.reviewer}</span>}
                    </b>
                  ) : verify.verdict === 'claim' ? (
                    <b>
                      <span className="vp-chip vp-chip-warn">tự báo cáo</span>
                      <span className="vp-muted"> · chưa qua đánh giá</span>
                    </b>
                  ) : task?.status === 'review' ? (
                    <b className="vp-muted">chờ đánh giá{verify.reviewer ? ` bởi ${verify.reviewer}` : ''}</b>
                  ) : (
                    <b className="vp-muted">chưa hoàn tất — chưa đánh giá</b>
                  )}
                </div>
                {verify.verdict === 'claim' && <div className="vp-warn">{verify.why}</div>}
                {verify.verdict === 'verified' && verify.verifiedAt != null && (
                  <div className="vp-muted">
                    đã xác nhận {new Date(verify.verifiedAt * 1000).toLocaleString('vi-VN')}
                    {verify.implementer ? ` · thực hiện bởi ${verify.implementer}` : ''}
                  </div>
                )}
                {verify.verdict === 'open' && verify.requestedAt != null && (
                  <div className="vp-muted">
                    đã gửi đánh giá {new Date(verify.requestedAt * 1000).toLocaleString('vi-VN')}
                    {verify.implementer ? ` bởi ${verify.implementer}` : ''}
                  </div>
                )}
                <div className="vp-muted">
                  đã đọc {age(Math.max(0, Math.round((Date.now() - Date.parse(verify.readAt)) / 1000)))} trước
                </div>
              </>
            )}

            {/* "Selesai" hanya klaim worker. Yang bisa diperiksa: ringkasan, run (outcome +
                metadata), lampiran, log. Done tanpa satu pun = TANPA BUKTI, tidak pernah hijau. */}
            <div className="vp-sub">BẰNG CHỨNG KẾT QUẢ</div>
            {evBusy && <div className="vp-muted">đang đọc bằng chứng…</div>}
            {evErr && <div className="vp-err">không đọc được bằng chứng: {evErr}</div>}
            {evidence && (
              <>
                <div className="vp-kv">
                  <span>đánh giá</span>
                  {evidence.verdict === 'proven' ? (
                    <b>
                      <span className="vp-chip">có bằng chứng</span>
                      {evidence.completedAgeSeconds != null && (
                        <span className="vp-muted"> · hoàn tất {age(evidence.completedAgeSeconds)} trước</span>
                      )}
                    </b>
                  ) : evidence.verdict === 'unproven' ? (
                    <b>
                      <span className="vp-chip vp-chip-warn">CHƯA CÓ BẰNG CHỨNG</span>
                    </b>
                  ) : (
                    <b className="vp-muted">chưa hoàn tất — chưa đánh giá</b>
                  )}
                </div>
                {evidence.verdict === 'unproven' && (
                  <div className="vp-warn">
                    Được đánh dấu hoàn tất nhưng không có bản tóm tắt, lần chạy có siêu dữ liệu, nhật ký hay tệp đính kèm
                    để kiểm tra.
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {evidence.items
                    .filter((it) => it.kind === 'summary' || it.kind === 'run')
                    .map((it, i) => (
                      <Collapsible key={`${it.kind}-${i}`} label={it.label} text={it.body || ''} />
                    ))}
                  {evidence.items.some((it) => it.kind === 'attachment') && (
                    <div className="vp-run">
                      <b>tệp đính kèm</b>
                      {evidence.items
                        .filter((it) => it.kind === 'attachment')
                        .map((it, i) => (
                          <div key={i} className="vp-muted">{it.label}</div>
                        ))}
                      <div className="vp-muted">CLI chỉ liệt kê tệp đính kèm; không thể mở nội dung tại đây.</div>
                    </div>
                  )}
                  {evidence.items.some((it) => it.kind === 'log') && (
                    <div className="vp-muted">có nhật ký tiến trình — xem “Nhật ký tiến trình” bên dưới.</div>
                  )}
                  {!evidence.items.length && <div className="vp-muted">không có bằng chứng từ cả bốn nguồn</div>}
                </div>
                <div className="vp-muted">
                  đã đọc {age(Math.max(0, Math.round((Date.now() - Date.parse(evidence.readAt)) / 1000)))} trước
                </div>
              </>
            )}

            <div className="vp-sub">LỊCH SỬ CHẠY ({runs.length})</div>
            {loading && <div className="vp-muted">đang tải…</div>}
            {err && <div className="vp-err">{err}</div>}
            <div className="flex flex-col gap-2">
              {runs
                .slice()
                .reverse()
                .map((r) => (
                  <div key={r.id} className="vp-run">
                    <b>{uiState(r.status)}</b>
                    {r.outcome ? <span> · {uiState(r.outcome)}</span> : null}
                    {r.profile ? <span className="vp-muted"> · {r.profile}</span> : null}
                    {r.summary && <div className="vp-muted">{r.summary}</div>}
                    {r.error && <div className="vp-err">{r.error}</div>}
                  </div>
                ))}
              {!loading && !runs.length && <div className="vp-muted">chưa có lần chạy nào</div>}
            </div>

            <Collapsible
              label="Nhật ký tiến trình"
              text={log}
              count={log.trim() ? log.trim().split('\n').length : undefined}
              empty="chưa có nhật ký"
            />
          </>
        )}
      </div>
    </aside>
  )
}
