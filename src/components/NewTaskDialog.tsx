'use client'

import { useState } from 'react'
import { useOffice } from '@/lib/store'
import { fetchJson } from '@/lib/api'

/** Dispatch a new task straight into the Hermes board. */
export default function NewTaskDialog() {
  const open = useOffice((s) => s.newTaskOpen)
  const setOpen = useOffice((s) => s.setNewTaskOpen)
  const agents = useOffice((s) => s.agents)
  const load = useOffice((s) => s.load)

  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState('')
  const [body, setBody] = useState('')
  const [priority, setPriority] = useState(0)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  if (!open) return null

  async function submit() {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetchJson<{ task: { id: string } }>('/api/hermes/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          assignee: assignee || agents[0]?.name,
          body,
          priority,
        }),
      })
      if (!res.ok || !res.data) throw new Error(res.error || 'không tạo được công việc')
      setNote(`Đã tạo: ${res.data.task.id}`)
      setTitle('')
      setBody('')
      await load()
      setTimeout(() => setOpen(false), 900)
    } catch (e) {
      setNote(`Thất bại: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vp-modal-backdrop" onClick={() => setOpen(false)}>
      <div className="vp-modal" onClick={(e) => e.stopPropagation()}>
        <header className="vp-panel-head">
          <h2>Công việc mới</h2>
          <button className="vp-x" onClick={() => setOpen(false)} aria-label="Đóng">×</button>
        </header>
        <div className="vp-pad flex flex-col gap-3">
          <label className="vp-sub">TIÊU ĐỀ</label>
          <input
            className="vp-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Thêm kiểm thử hoàn tiền không bị lặp"
          />

          <label className="vp-sub">NGƯỜI PHỤ TRÁCH</label>
          <select
            className="vp-input"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.name} value={a.name}>{a.displayName}</option>
            ))}
          </select>

          <label className="vp-sub">CHI TIẾT (KHÔNG BẮT BUỘC)</label>
          <textarea
            className="vp-input"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Bối cảnh, tiêu chí nghiệm thu"
          />

          <label className="vp-sub">ĐỘ ƯU TIÊN</label>
          <input
            className="vp-input"
            type="number"
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
          />

          <button className="vp-btn" disabled={busy || !title.trim()} onClick={submit}>
            {busy ? 'Đang gửi…' : 'Gửi vào hàng đợi'}
          </button>
          {note && <div className="vp-note">{note}</div>}
        </div>
      </div>
    </div>
  )
}
