'use client'

import { useEffect, useState } from 'react'
import { useOffice } from '@/lib/store'
import Collapsible from './Collapsible'
import { uiState } from './UiLabels'
import type { Agent, Task } from '@/types/hermes'
import { fetchJson } from '@/lib/api'

type RunInfo = {
  id: number
  profile: string
  status: string
  outcome?: string | null
  summary?: string | null
  error?: string | null
}

/** "Intip layar": live log + steer/cancel for whoever occupies a desk. */
export default function PeekPanel() {
  const desk = useOffice((s) => s.peekDesk)
  const setPeek = useOffice((s) => s.setPeek)
  const agents = useOffice((s) => s.agents)
  const tasks = useOffice((s) => s.tasks)
  const load = useOffice((s) => s.load)

  const [log, setLog] = useState('')
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const agent: Agent | undefined = agents.find((a) => a.deskIndex === desk)
  const task: Task | undefined = tasks.find((t) => t.id === agent?.currentTaskId)

  useEffect(() => {
    if (!task) {
      setLog('')
      setRuns([])
      return
    }
    let alive = true
    const pull = async () => {
      // Polls every 5 s: a dropped packet must leave the last known log on screen
      // rather than clearing it or flashing an error.
      const res = await fetchJson<{ log?: string; runs?: RunInfo[] }>(
        `/api/hermes/tasks/${task.id}`,
        { cache: 'no-store' },
      )
      if (!alive || !res.ok || !res.data) return
      setLog(res.data.log || '')
      setRuns(res.data.runs || [])
    }
    pull()
    const id = setInterval(pull, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [task?.id])

  if (desk == null) return null

  async function act(action: 'steer' | 'cancel') {
    if (!task) return
    setBusy(true)
    setNote(null)
    try {
      const res = await fetchJson(`/api/hermes/tasks/${task.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, message: msg }),
      })
      if (!res.ok) throw new Error(res.error || 'thao tác thất bại')
      setNote(action === 'steer' ? 'Đã gửi chỉ dẫn cho tiến trình.' : 'Đã giải phóng quyền giữ việc của tiến trình.')
      setMsg('')
      void load()
    } catch (e) {
      setNote(`Thất bại: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="vp-panel right-0">
      <header className="vp-panel-head">
        <h2>Bàn {desk + 1} · {agent?.displayName || 'trống'}</h2>
        <button className="vp-x" onClick={() => setPeek(null)} aria-label="Đóng">×</button>
      </header>

      {!agent && <div className="vp-pad vp-muted">Không có tác tử ở bàn này.</div>}

      {agent && (
        <div className="vp-pad flex flex-col gap-3">
          <div className="vp-kv">
            <span>trạng thái</span><b>{uiState(agent.status)}</b>
          </div>
          <div className="vp-kv">
            <span>công việc</span><b>{task?.title || '— không có việc đang chạy —'}</b>
          </div>
          {task && <code className="vp-code-block">{task.id}</code>}

          {task && (
            <>
              <Collapsible
                label="Nhật ký gần nhất"
                text={log}
                count={log.trim() ? log.trim().split('\n').length : undefined}
                defaultOpen
                empty="nhật ký còn trống"
              />

              <Collapsible
                label="Lịch sử chạy"
                count={runs.length}
                empty="chưa có lần chạy nào"
              >
                <div className="flex flex-col gap-1">
                  {runs.slice(-4).reverse().map((r) => (
                    <div key={r.id} className="vp-run">
                      <b>{uiState(r.status)}</b>
                      {r.outcome ? <span> · {uiState(r.outcome)}</span> : null}
                      {r.summary ? <div className="vp-muted">{r.summary}</div> : null}
                      {r.error ? <div className="vp-err">{r.error}</div> : null}
                    </div>
                  ))}
                </div>
              </Collapsible>

              <div className="vp-sub">CHỈ DẪN / DỪNG</div>
              <textarea
                className="vp-input"
                rows={3}
                placeholder="chỉ tập trung kiểm thử Postgres"
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
              />
              <div className="flex gap-2">
                <button className="vp-btn" disabled={busy || !msg.trim()} onClick={() => act('steer')}>
                  Gửi chỉ dẫn
                </button>
                <button className="vp-btn vp-btn-warn" disabled={busy} onClick={() => act('cancel')}>
                  Dừng
                </button>
              </div>
              {note && <div className="vp-note">{note}</div>}
            </>
          )}
        </div>
      )}
    </aside>
  )
}
