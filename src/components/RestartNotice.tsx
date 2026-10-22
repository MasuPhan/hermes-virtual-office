'use client'

/**
 * Pop up "SILAHKAN RESTART SERVER" — dipakai SETELAH spawn/menyimpan agent.
 *
 * Aturan jujur yang dipegang:
 * - Setelan TERSIMPAN tapi baru BERLAKU setelah restart (daftar served dibaca
 *   SEKALI saat gateway boot — tidak ada hot reload). Tidak ada "siap
 *   dipanggil" sebelum restart.
 * - Apa yang belum bisa sebelum restart: agent belum bisa dipanggil lewat A2A;
 *   rapat mode `a2a` akan menolaknya (menyebut dia belum di-serve).
 * - RESTART-SAFE-1: restart MEMBUNUH worker kanban yang sedang berjalan
 *   (bukti nyata: DOCS-2 crash "pid not alive" saat gateway di-restart).
 *   Pop up MEMBACA daftar card berjalan dari route (bukan menebak), dan
 *   MENAMPILKANNYA di sini — bukan di log: id + judul tiap card + kalimat
 *   "N card sedang dikerjakan — restart akan membunuh worker-nya, dan
 *   pekerjaan yang belum dikomit akan hilang." Ada yang berjalan (atau board
 *   tak terbaca = `unknown`) → tombol meminta centang konfirmasi eksplisit
 *   dulu, baru mengirim { confirm: true }. Tidak ada yang berjalan → tombol
 *   langsung jalan seperti dulu (operasi biasa jangan dibuat ribet).
 * - Pendaftaran GAGAL = pop up gagal (bukan pop up ini) — pemanggil yang
 *   memutuskan, bukan komponen ini.
 * - Tombol "Restart sekarang" memanggil route /api/hermes/gateway-restart
 *   (unit gw-restart.service, jalur yang SAMA dengan manual — bukan mekanisme
 *   kedua). Gagal = tampilkan perintah manual yang bisa disalin — jangan
 *   sukses palsu.
 * - Perintah restart portabel dulu (`hermes gateway restart`); unit
 *   gw-restart.service opsional host-specific. Path biner host TIDAK ditulis
 *   di UI publik (alat khusus satu host).
 */

import { useEffect, useState } from 'react'
import { fetchJson } from '@/lib/api'

const MANUAL_CMD = 'hermes gateway restart'
const MANUAL_UNIT = 'systemctl --user start gw-restart.service'

/** Satu card berjalan — cukup untuk diputuskan operator (id + judul). */
type RunningCard = { id: string; title: string; assignee: string | null }

type Probe =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'running'; count: number; cards: RunningCard[]; message: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'error'; message: string }

export default function RestartNotice({
  agentName,
  onClose,
}: {
  /** Nama agent yang baru dibuat/disimpan — disebut di teks jujur. */
  agentName: string
  onClose: () => void
}) {
  const [restartBusy, setRestartBusy] = useState(false)
  /** null = belum dicoba; string = hasil mentah apa adanya (sukses/gagal). */
  const [restartResult, setRestartResult] = useState<string | null>(null)
  const [restartFailed, setRestartFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  /** Daftar card berjalan — dibaca SEKALI saat pop up dibuka. */
  const [probe, setProbe] = useState<Probe>({ kind: 'loading' })
  /** Centang konfirmasi eksplisit — wajib bila ada yang berjalan / unknown. */
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      // Read-only dari endpoint board: daftar yang SAMA dipakai penjaga route
      // (`readRunningKanbanCards`), jadi pop up dan route tak berbeda pendapat.
      // TIDAK probe ke route restart: probe ke sana akan MENJADWALKAN restart
      // sungguhan saat kosong. Gagal baca = `unknown` (jangan mewakili).
      const res = await fetchJson<{ running?: RunningCard[] }>(
        '/api/hermes/board',
        { method: 'GET' },
      )
      if (!alive) return
      if (!res.ok || !Array.isArray(res.data?.running)) {
        setProbe({ kind: 'unknown', message: `Không đọc được danh sách thẻ đang chạy (${res.error ?? 'không đọc được bảng'}) — chưa xác định được có công việc đang chạy hay không.` })
        return
      }
      const cards = res.data.running.map((t) => ({ id: t.id, title: t.title, assignee: t.assignee ?? null }))
      if (!cards.length) {
        setProbe({ kind: 'empty' })
        return
      }
      setProbe({
        kind: 'running',
        count: cards.length,
        cards,
        message: `${cards.length} thẻ đang được xử lý — khởi động lại sẽ dừng các tiến trình, và phần việc chưa commit sẽ bị mất.`,
      })
    }
    void load()
    return () => {
      alive = false
    }
  }, [])

  /** Perlu konfirmasi eksplisit bila ada yang berjalan ATAU tak pasti. */
  const needsConfirm = probe.kind === 'running' || probe.kind === 'unknown'

  const restartBlocked = restartBusy || probe.kind === 'loading' || (needsConfirm && !confirmed)

  async function restartNow(withConfirm: boolean) {
    if (restartBlocked) return
    setRestartBusy(true)
    setRestartResult(null)
    setRestartFailed(false)
    try {
      const res = await fetchJson<{ message?: string; manual?: string[]; running?: RunningCard[]; runningCount?: number }>(
        '/api/hermes/gateway-restart',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withConfirm ? { confirm: true } : {}),
        },
      )
      if (res.ok) {
        // Jujur: dijadwalkan, BUKAN selesai. Halaman akan putus sebentar.
        setRestartResult(res.data?.message ?? 'Đã lên lịch khởi động lại.')
        setRestartFailed(false)
      } else if (res.status === 409) {
        // Guard menolak — tampilkan daftar + kalimatnya DI POP UP (bukan log).
        const n = res.data?.runningCount ?? res.data?.running?.length ?? 0
        const list = (res.data?.running ?? []).map((c) => `${c.id} — ${c.title}`).join('\n')
        setRestartResult(
          `${res.data?.message ?? res.error ?? 'Đã chặn khởi động lại.'}${list ? `\n\nĐang được xử lý:\n${list}` : ''}${n ? '' : ''}`,
        )
        setRestartFailed(true)
        // Sinkronkan probe dari penolakan route (sumber jujur kedua).
        const rc = (res.data?.running ?? []).map((c) => ({ id: c.id, title: c.title, assignee: c.assignee ?? null }))
        if (rc.length) {
          setProbe({
            kind: 'running',
            count: res.data?.runningCount ?? rc.length,
            cards: rc,
            message: res.data?.message ?? `${rc.length} thẻ đang được xử lý — khởi động lại sẽ dừng các tiến trình, và phần việc chưa commit sẽ bị mất.`,
          })
        }
      } else {
        setRestartResult(
          `${res.error ?? 'Không lên lịch được việc khởi động lại.'} Chạy thủ công: ${(res.data?.manual ?? [MANUAL_CMD]).join('  ·  ')}`,
        )
        setRestartFailed(true)
      }
    } catch (e) {
      setRestartResult(`Không lên lịch được việc khởi động lại (${(e as Error).message}). Chạy thủ công: ${MANUAL_CMD}`)
      setRestartFailed(true)
    } finally {
      setRestartBusy(false)
    }
  }

  async function copyManual() {
    try {
      await navigator.clipboard.writeText(`${MANUAL_CMD}\n${MANUAL_UNIT}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard ditolak: teks tetap terlihat, salin manual
    }
  }

  return (
    <div className="vp-modal-backdrop" onClick={onClose}>
      <div className="vp-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Vui lòng khởi động lại máy chủ</h3>
        <p className="vp-sub">
          Cấu hình của &quot;{agentName}&quot; ĐÃ LƯU, nhưng chỉ CÓ HIỆU LỰC sau khi khởi động lại máy chủ — danh sách served-agent
          chỉ được đọc MỘT LẦN khi gateway khởi chạy, không tự nạp lại.
        </p>
        <p className="vp-note">
          Trước khi khởi động lại: &quot;{agentName}&quot; CHƯA thể được gọi qua A2A, và cuộc họp ở chế độ <b>a2a</b> sẽ
          từ chối (do tác tử chưa được phục vụ).
        </p>

        {/* RESTART-SAFE-1: daftar card berjalan — DI POP UP, bukan di log. */}
        {probe.kind === 'loading' && (
          <p className="vp-note">đang kiểm tra thẻ được xử lý…</p>
        )}
        {probe.kind === 'running' && (
          <div className="vp-err" role="alert">
            <b>{probe.message}</b>
            <ul style={{ marginTop: 6, paddingLeft: 18 }}>
              {probe.cards.map((c) => (
                <li key={c.id}>
                  <span className="font-mono">{c.id}</span> — {c.title}
                  {c.assignee ? <span className="text-slate-400"> ({c.assignee})</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        {probe.kind === 'unknown' && (
          <div className="vp-err" role="alert">
            <b>{probe.message}</b>
            <div className="mt-1 text-xs">Chọn bên dưới nghĩa là bạn chấp nhận quyết định khi chưa rõ trạng thái — hệ thống không quyết định thay bạn.</div>
          </div>
        )}

        {needsConfirm && !restartResult && (
          <label className="mt-2 flex items-start gap-2 text-xs" style={{ display: 'flex', marginTop: 8 }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              Tôi hiểu khởi động lại sẽ dừng tiến trình đang chạy và phần việc chưa commit sẽ
              bị mất. Vẫn khởi động lại.
            </span>
          </label>
        )}

        {!restartResult && (
          <div className="vp-modal-actions">
            <button className="vp-btn" onClick={onClose}>
              Để sau
            </button>
            <button
              className="vp-btn primary"
              onClick={() => void restartNow(needsConfirm ? confirmed : false)}
              disabled={restartBlocked}
              title={
                probe.kind === 'empty'
                  ? 'Không có thẻ đang chạy — sẽ lên lịch khởi động lại ngay'
                  : needsConfirm && !confirmed
                    ? 'Chọn xác nhận trước — có công việc đang chạy (hoặc chưa rõ)'
                    : 'Khởi động lại ngay'
              }
            >
              {restartBusy ? 'Đang lên lịch…' : 'Khởi động lại ngay'}
            </button>
          </div>
        )}
        {restartResult && (
          <div className={restartFailed ? 'vp-err' : 'vp-ok'}>
            {restartResult}
            {restartFailed && (
              <div className="flex flex-col gap-2" style={{ marginTop: 8 }}>
                <textarea
                  rows={2}
                  readOnly
                  value={`${MANUAL_CMD}\n${MANUAL_UNIT}`}
                  aria-label="Lệnh khởi động lại thủ công"
                  style={{ width: '100%' }}
                />
                <div>
                  <button className="vp-chip-btn" onClick={() => void copyManual()}>
                    {copied ? 'đã sao chép ✓' : 'sao chép lệnh'}
                  </button>
                </div>
              </div>
            )}
            <div className="vp-modal-actions" style={{ marginTop: 8 }}>
              <button className="vp-btn primary" onClick={onClose} autoFocus>
                Đã hiểu
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
