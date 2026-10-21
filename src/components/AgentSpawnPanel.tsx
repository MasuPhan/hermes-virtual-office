'use client'

import { useEffect, useState } from 'react'
import { fetchJson } from '@/lib/api'
import ModelPicker, { type ModelChoice } from './ModelPicker'
import type { AgentDivision, AgentRole } from '@/types/hermes'
import { UI_DIVISION_LABEL as DIVISION_LABEL, UI_ROLE_LABEL as ROLE_LABEL } from './UiLabels'
import FullPanel from './FullPanel'
import RestartNotice from './RestartNotice'
import AvatarPanel from './AvatarPanel'
import { useOffice } from '@/lib/store'
import { officeDivision } from '@/lib/office/types'

/**
 * Spawn / hide / kill control.
 *
 * "Sembunyikan" and "Spawn" toggle office MEMBERSHIP
 * (src/lib/hermes/office-membership.ts): the avatar leaves or enters, the profile
 * and its tasks are untouched. "Kill" is the destructive one — it deletes the
 * profile and purges its tasks — so it is only offered when a profile exists and
 * asks for a second click.
 */

type Row = {
  name: string
  total: number
  /** The profile exists on disk, not only as a task assignee. */
  profile: boolean
  inOffice: boolean
  reason: string | null
  /** The profile's default model, when it has one. */
  model?: string | null
  /** Role dari route agents GET; null/undefined bila backend lama. */
  role?: AgentRole | string | null
  /** Divisi dari route agents GET; null/undefined bila backend lama. */
  division?: AgentDivision | string | null
  /** True bila profil punya SOUL.md sendiri. */
  soulExists?: boolean | null
  /** Keahlian/domain (dipakai office, bukan A2A). */
  domains?: string[]
  /**
   * Status A2A jujur: 'served' = terdaftar di platforms.a2a.agents,
   * 'unlisted' = belum didaftarkan. Bukan "aktif" — berlaku pasca-restart.
   */
  a2a?: 'served' | 'unlisted' | null
}

/** Batas izin per role dari route agents GET (tabel tunggal di control.ts). */
type Permissions = Record<string, { allow: string[]; deny: string[]; anyTask: boolean }>

const ROLE_OPTIONS = Object.entries(ROLE_LABEL) as [AgentRole, string][]
const DIVISION_OPTIONS = Object.entries(DIVISION_LABEL) as [AgentDivision, string][]

export default function AgentSpawnPanel({
  open,
  onClose,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const avatars = useOffice((s) => s.avatars)
  const [rows, setRows] = useState<Row[]>([])
  const [perms, setPerms] = useState<Permissions>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newRole, setNewRole] = useState<AgentRole>('backend')
  const [newDivision, setNewDivision] = useState<AgentDivision>('tech')
  const [newSoul, setNewSoul] = useState('')
  /**
   * Keahlian/domain: freetext koma ("meta-ads, reporting"). Disimpan di
   * marker SOUL.md (pemetaan office), TIDAK diumumkan ke A2A — skills di
   * agent card hanya bisa berisi toolset Hermes yang nyata.
   */
  const [newDomains, setNewDomains] = useState('')
  /**
   * Toolset yang diumumkan di agent card. Kosong = semua toolset.
   * Hanya nama toolset nyata (dari /api/hermes/toolsets), bukan tag bebas.
   */
  const [newToolsets, setNewToolsets] = useState<string[]>([])
  const [toolsetCatalog, setToolsetCatalog] = useState<{ name: string; enabled: boolean }[]>([])
  /**
   * Toggle A2A: default MATI (opt-in). Hanya `serveA2a: true` eksplisit yang
   * mencoba mendaftarkan served-agent; create tidak menyentuh config gateway
   * secara diam-diam.
   */
  const [newServeA2a, setNewServeA2a] = useState(false)
  /** Domain yang tidak punya pemilik: dinyatakan apa adanya, bukan diarang. */
  const [domainOwners, setDomainOwners] = useState<Record<string, string | null>>({})
  /** Model untuk profil yang SEDANG dibuat; '' = bawaan Hermes. Terpisah dari `pick`
   *  (ganti model profil yang sudah ada) supaya dua alur itu tidak saling menimpa. */
  const [newModel, setNewModel] = useState('')
  const [soulPreview, setSoulPreview] = useState<string | null>(null)
  const [divFilter, setDivFilter] = useState<'all' | AgentDivision>('all')
  const [creating, setCreating] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  /** id awaiting the second click before a destructive delete. */
  const [confirmKill, setConfirmKill] = useState<string | null>(null)
  const [models, setModels] = useState<ModelChoice[]>([])
  /** name -> model being picked but not yet saved. */
  const [pick, setPick] = useState<Record<string, string>>({})
  /**
   * Keadaan "butuh restart" dari server (SATU sumber kebenaran — pembanding
   * yang sama dipakai doctor). null = tak bisa dipastikan (tampil abu).
   */
  const [needsGatewayRestart, setNeedsGatewayRestart] = useState<boolean | null>(null)
  /** Pop up "silahkan restart server" — tampil setelah pendaftaran A2A sukses. */
  const [restartFor, setRestartFor] = useState<string | null>(null)

  // A click anywhere else cancels a pending delete.
  useEffect(() => {
    if (!confirmKill) return
    const cancel = () => setConfirmKill(null)
    window.addEventListener('click', cancel)
    return () => window.removeEventListener('click', cancel)
  }, [confirmKill])

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchJson<{ available?: Row[]; permissions?: Permissions; domainOwners?: Record<string, string | null>; needsGatewayRestart?: boolean | null }>('/api/hermes/agents', {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(res.error || 'không tải được danh sách tác tử')
      setRows(res.data?.available || [])
      setPerms(res.data?.permissions || {})
      setDomainOwners(res.data?.domainOwners || {})
      setNeedsGatewayRestart(res.data?.needsGatewayRestart ?? null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load()
  }, [open])

  // Katalog toolset + model: config, bukan roster — fetch sekali per buka.
  useEffect(() => {
    if (!open) return
    if (!models.length) {
      let alive = true
      fetchJson<{ models?: ModelChoice[] }>('/api/hermes/models', { cache: 'no-store' }).then((res) => {
        if (alive && res.ok) setModels(res.data?.models || [])
      })
      return () => {
        alive = false
      }
    }
  }, [open, models.length])
  useEffect(() => {
    if (!open || toolsetCatalog.length) return
    let alive = true
    fetchJson<{ toolsets?: { name: string; enabled: boolean }[] }>('/api/hermes/toolsets', { cache: 'no-store' }).then((res) => {
      if (alive && res.ok) setToolsetCatalog(res.data?.toolsets || [])
    })
    return () => {
      alive = false
    }
  }, [open, toolsetCatalog.length])

  async function setModel(name: string, model: string) {
    setBusy(name)
    setErr(null)
    setNote(null)
    try {
      const hit = models.find((m) => m.model === model)
      const res = await fetchJson('/api/hermes/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-model', name, model, provider: hit?.provider }),
      })
      if (!res.ok) throw new Error(res.error || 'không lưu được mô hình')
      setNote(`Mô hình của "${name}" được đặt thành ${model} — áp dụng cho lần khởi chạy/trò chuyện tiếp theo.`)
      await load()
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function act(action: 'spawn' | 'hide' | 'kill' | 'serve' | 'unserve', name: string) {
    setBusy(name)
    setErr(null)
    setNote(null)
    try {
      const res = await fetchJson<{
        purged?: number
        a2aNote?: string | null
        peerAdded?: boolean | null
        peerError?: string | null
        toolsetAdded?: boolean | null
        toolsetError?: string | null
        needsGatewayRestart?: boolean | null
      }>('/api/hermes/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name }),
      })
      if (!res.ok) throw new Error(res.error || 'thao tác thất bại')
      const d = res.data
      if (action === 'kill') {
        const n = Number(d?.purged ?? 0)
        setNote(
          n > 0
            ? `"${name}" đã bị xóa vĩnh viễn cùng ${n} việc của tác tử`
            : `"${name}" đã bị xóa vĩnh viễn`,
        )
      } else if (action === 'hide') {
        setNote(`"${name}" đã ẩn — công việc vẫn còn trên bảng`)
      } else if (action === 'serve') {
        // SELFREPAIR-1 Celah 1: jujur — terdaftar, tapi BERLAKU SETELAH
        // restart gateway (bukan langsung "siap"). A2A-CALL-1: pratinjau +
        // laporan kemampuan MEMANGGIL (peer + toolset, idempoten).
        const callBits: string[] = []
        if (d?.toolsetAdded === true) callBits.push('đã thêm bộ công cụ a2a (có thể gọi)')
        else if (d?.toolsetAdded === false && d?.toolsetError) callBits.push(`thêm bộ công cụ a2a THẤT BẠI (${d.toolsetError})`)
        else callBits.push('bộ công cụ a2a đã có (có thể gọi)')
        if (d?.peerAdded === true) callBits.push(`peer ${name}-local đã đăng ký`)
        else if (d?.peerAdded === false && d?.peerError) callBits.push(`đăng ký peer THẤT BẠI (${d.peerError})`)
        else callBits.push(`peer ${name}-local đã có`)
        setNote(`"${name}" ${d?.a2aNote ?? 'đã đăng ký. Có hiệu lực sau khi khởi động lại gateway.'} ${callBits.join(' · ')}.`)
        if (d?.needsGatewayRestart != null) setNeedsGatewayRestart(d.needsGatewayRestart)
      } else if (action === 'unserve') {
        setNote(`"${name}" ${d?.a2aNote ?? 'đã gỡ khỏi cấu hình.'}`)
      }
      await load()
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function create() {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    setErr(null)
    setNote(null)
    setSoulPreview(null)
    try {
      const hit = models.find((m) => m.model === newModel)
      const res = await fetchJson<{
        name: string
        soulPreview?: string
        model?: string | null
        modelError?: string | null
        domains?: string[]
        a2aRegistered?: boolean | null
        a2aError?: string | null
        toolsetAdded?: boolean | null
        toolsetError?: string | null
        peerAdded?: boolean | null
        peerError?: string | null
        a2aNote?: string | null
        needsGatewayRestart?: boolean | null
      }>('/api/hermes/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name,
          description: newDesc.trim(),
          role: newRole,
          division: newDivision,
          soul: newSoul.trim(),
          domains: newDomains.trim(),
          advertisedToolsets: newToolsets,
          serveA2a: newServeA2a,
          model: newModel || undefined,
          provider: newModel ? hit?.provider : undefined,
        }),
      })
      if (!res.ok || !res.data) throw new Error(res.error || 'không tạo được hồ sơ')
      setNewName('')
      setNewDesc('')
      setNewSoul('')
      setNewDomains('')
      setNewToolsets([])
      setNewServeA2a(false)
      setNewModel('')
      setSoulPreview(res.data.soulPreview ?? null)
      // Laporkan model dari BALASAN server, bukan dari pilihan di form: kalau set-model
      // gagal, operator harus tahu agent ini jalan dengan bawaan Hermes.
      const modelNote = res.data.model
        ? `mô hình ${res.data.model}`
        : res.data.modelError
          ? `đặt mô hình THẤT BẠI (${res.data.modelError}) — tạm dùng mặc định của Hermes`
          : 'mô hình mặc định của Hermes'
      const domNote = res.data.domains?.length ? `chuyên môn: ${res.data.domains.join(', ')} (phân công trong văn phòng, không phải A2A). ` : ''
      const a2aNote = res.data.a2aRegistered === true
        ? `${res.data.a2aNote ?? 'Đã lưu. Có hiệu lực sau khi khởi động lại gateway.'} `
        : res.data.a2aRegistered === false
          ? `Đăng ký A2A THẤT BẠI (${res.data.a2aError}) — hồ sơ đã có nhưng chưa được đăng ký. `
          : 'Chưa đăng ký A2A (đang tắt) — hồ sơ đã có nhưng chưa được đăng ký. Bật thủ công nếu cần. '
      // A2A-CALL-1: kemampuan MEMANGGIL ikut dilaporkan (pratinjau + laporan,
      // idempoten — dua kali jalan tak menggandakan).
      const callNote = res.data.a2aRegistered === true
        ? (res.data.toolsetAdded === true
          ? 'đã thêm bộ công cụ a2a (có thể gọi). '
          : res.data.toolsetAdded === false && res.data.toolsetError
            ? `thêm bộ công cụ a2a THẤT BẠI (${res.data.toolsetError}). `
            : 'bộ công cụ a2a đã có (có thể gọi). ') +
          (res.data.peerAdded === true
            ? `peer ${res.data.name}-local đã đăng ký (có thể phân giải tên). `
            : res.data.peerAdded === false && res.data.peerError
              ? `đăng ký peer THẤT BẠI (${res.data.peerError}). `
              : `peer ${res.data.name}-local đã có. `)
        : ''
      setNote(`hồ sơ "${res.data.name}" đã tạo, ${modelNote} — tác tử đi vào qua cửa chính. ${domNote}${a2aNote}${callNote}`)
      setNeedsGatewayRestart(res.data.needsGatewayRestart ?? null)
      // Pendaftaran A2A sukses → pop up "silahkan restart server". Gagal =
      // JANGAN tampilkan pop up sukses (catatan di atas sudah bilang gagal).
      if (res.data.a2aRegistered === true) setRestartFor(res.data.name)
      await load()
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  if (!open) return null

  const divisionFor = (r: Row) => officeDivision(avatars.find((a) => a.avatarId === `agent:${r.name}`) ?? { useHermesDivision: true }, r.division as AgentDivision | null)
  const matchDiv = (r: Row) => divFilter === 'all' || divisionFor(r) === divFilter
  const inOffice = rows.filter((r) => r.inOffice && matchDiv(r))
  const out = rows.filter((r) => !r.inOffice && matchDiv(r))

  /** Badge role + divisi + indikator soul + status A2A. Aman bila field null (backend lama). */
  function badges(r: Row) {
    const roleLabel = r.role ? (ROLE_LABEL as Record<string, string>)[r.role] ?? r.role : null
    const divLabel = DIVISION_LABEL[divisionFor(r)]
    return (
      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
        {roleLabel && (
          <span className="vp-chip" title={`vai trò: ${r.role}`}>
            {roleLabel}
          </span>
        )}
        {divLabel && (
          <span className="vp-chip" title={`bộ phận: ${r.division}`}>
            {divLabel}
          </span>
        )}
        {(r.domains?.length ?? 0) > 0 && (
          <span className="vp-chip" title={`chuyên môn (phân công trong văn phòng, không phải A2A): ${(r.domains ?? []).join(', ')}`}>
            {(r.domains ?? []).join(', ')}
          </span>
        )}
        {r.soulExists === true && (
          <span className="vp-chip" title="Hồ sơ này có SOUL.md riêng">
            SOUL ✓
          </span>
        )}
        {r.soulExists === false && <span className="vp-tag-warn">chưa có SOUL</span>}
        {a2aBadge(r)}
      </span>
    )
  }

  /**
   * Checklist "A2A Ready" per agent — tiga nilai jujur, SATU sumber kebenaran
   * (entri served + needsGatewayRestart dari server, pembanding yang sama
   * dipakai doctor):
   * - ✅ A2A Ready: terdaftar DAN gateway sudah restart sesudahnya.
   * - 🟡 Terdaftar, belum aktif: ada entri tapi config lebih baru dari start.
   * - ❌ Belum terdaftar: tidak ada entri served.
   * needsGatewayRestart null = tak bisa dipastikan → abu, bukan hijau.
   */
  function a2aBadge(r: Row) {
    if (r.a2a !== 'served') {
      // SELFREPAIR-1 Celah 1: agent `unlisted` (profil ada, belum didaftarkan)
      // bisa didaftarkan dari UI — aksi `serve` + kalimat jujur (berlaku
      // setelah restart). Profil tak ada (null) = tak ada tombol.
      if (r.a2a === 'unlisted' && r.profile) {
        return (
          <span className="flex flex-wrap items-center gap-2">
            <span className="vp-tag-warn" title="Chưa có mục trong platforms.a2a.agents">
              ❌ Chưa đăng ký A2A
            </span>
            <button
              className="vp-chip-btn"
              disabled={busy === r.name}
              onClick={(e) => {
                e.stopPropagation()
                void act('serve', r.name)
              }}
              title="Đăng ký hồ sơ này vào platforms.a2a.agents (local:false). Có hiệu lực sau khi khởi động lại gateway."
            >
              {busy === r.name ? '…' : 'đăng ký A2A'}
            </button>
          </span>
        )
      }
      return (
        <span className="vp-tag-warn" title="Chưa có mục trong platforms.a2a.agents — hãy bật A2A cho tác tử này">
          ❌ Chưa đăng ký A2A — hãy bật A2A cho tác tử này
        </span>
      )
    }
    if (needsGatewayRestart === true) {
      return (
        <span className="vp-tag-warn" title="Đã có trong platforms.a2a.agents, nhưng config.yaml mới hơn lần chạy gateway — đăng ký chỉ có hiệu lực sau khi khởi động lại">
          🟡 Đã đăng ký, chưa hoạt động — cần khởi động lại gateway
        </span>
      )
    }
    if (needsGatewayRestart === false) {
      return (
        <span className="vp-chip" title="Đã đăng ký VÀ gateway đã khởi động lại sau đó — có thể gọi thực sự">
          ✅ A2A sẵn sàng — có thể gọi tác tử này ngay
        </span>
      )
    }
    return (
      <span className="vp-tag-warn" title="Đã đăng ký nhưng không đọc được thời điểm chạy gateway — chưa xác định được trạng thái hoạt động">
        Đã đăng ký A2A (chưa rõ hoạt động — không đọc được thời điểm chạy gateway)
      </span>
    )
  }

  /** Satu baris batas izin untuk role agent ini. Kosong bila role/tabel tidak ada. */
  function limits(r: Row) {
    const p = r.role ? perms[r.role] : undefined
    if (!p) return null
    const allow = p.allow.length
      ? p.allow.join(', ') + (p.anyTask ? '' : ' (chỉ việc của mình)')
      : '—'
    return (
      <span className="vp-muted" style={{ fontSize: 11 }} title="Giới hạn quyền khi yêu cầu thao tác thay mặt tác tử này">
        được phép: {allow} · không được phép: {p.deny.length ? p.deny.join(', ') : '—'}
      </span>
    )
  }

  return (
    <FullPanel onClose={onClose} label="Tác tử" title="Tác tử" bodyClassName="vp-pad flex flex-col gap-3">
      {restartFor && <RestartNotice agentName={restartFor} onClose={() => setRestartFor(null)} />}
      <div className="vp-kv">
        <span>trong văn phòng</span>
        <b>{inOffice.length}</b>
      </div>
      <div className="vp-kv">
        <span>hồ sơ hiện có</span>
        <b>{rows.length}</b>
      </div>
      {needsGatewayRestart === true && (
        <div className="vp-err">
          🟡 Cấu hình mới hơn lần chạy gateway — đăng ký đã lưu nhưng CHƯA hoạt động. Khởi động lại gateway để
          kích hoạt.
        </div>
      )}

      {err && <div className="vp-err">{err}</div>}
      {note && <div className="vp-ok">{note}</div>}
      {soulPreview && (
        <div className="vp-ok">
          <b>Đã lưu SOUL:</b>
          <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: 11 }}>{soulPreview}</pre>
        </div>
      )}
      {loading && <div className="vp-muted">đang tải…</div>}

      <div className="vp-sub">TẠO HỒ SƠ MỚI</div>
      <input
        className="vp-input"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        placeholder="budi"
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create()
        }}
      />
      {/*
        Deskripsi = `description` di agent card A2A: teks yang dibaca agent
        pemanggil untuk memutuskan "ini orangnya". Tulis BUAT DIBACA AGENT
        LAIN (kosakata domain yang akan dicari), bukan sekadar label manusia.
      */}
      <textarea
        className="vp-input"
        value={newDesc}
        onChange={(e) => setNewDesc(e.target.value)}
        placeholder="Mô tả thẻ tác tử — TÁC TỬ KHÁC đọc khi tìm kiếm. Dùng từ khóa chuyên môn, ví dụ: Quản lý quảng cáo Meta & Google: ngân sách, CPA, báo cáo hiệu quả hằng tuần. Liên hệ để lấy chi phí hoặc kết quả chiến dịch."
        rows={2}
      />
      {/*
        Keahlian/domain: daftar koma ("meta-ads, reporting"). Dipakai OFFICE
        untuk pemetaan domain→pemilik — TIDAK diumumkan ke A2A (skills di card
        hanya bisa berisi toolset Hermes yang nyata, lihat pilihan di bawah).
      */}
      <input
        className="vp-input"
        value={newDomains}
        onChange={(e) => setNewDomains(e.target.value)}
        placeholder="Chuyên môn/lĩnh vực, cách nhau bằng dấu phẩy — ví dụ: meta-ads, reporting, budget (phân công trong văn phòng, không phải A2A)"
      />
      <div className="flex gap-2">
        <select
          className="vp-input"
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as AgentRole)}
          title="Vai trò tác tử"
        >
          {ROLE_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="vp-input"
          value={newDivision}
          onChange={(e) => setNewDivision(e.target.value as AgentDivision)}
          title="Bộ phận của tác tử"
        >
          {DIVISION_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="vp-input"
        value={newSoul}
        onChange={(e) => setNewSoul(e.target.value)}
        placeholder="Ví dụ: Budi là CEO có tầm nhìn — quyết định cuối cùng, giao việc cho từng bộ phận, giữ định hướng công ty. Phong cách: quyết đoán, ngắn gọn, làm ngay. (không bắt buộc)"
        rows={3}
      />
      <ModelPicker
        value={newModel}
        onChange={setNewModel}
        models={models}
        disabled={creating}
        emptyLabel="mặc định của Hermes"
        title="Mô hình cho tác tử mới (để trống = mặc định của Hermes)"
      />
      {/*
        Toolset yang DIUMUMKAN di agent card (`advertised_toolsets`). Hanya
        nama toolset nyata Hermes — skills di card diturunkan dari registry,
        bukan tag bebas. Kosong = umumkan semua toolset.
      */}
      <div className="vp-sub" title="Bộ công cụ thực được công bố trên thẻ tác tử A2A. Để trống = tất cả.">
        CÔNG BỐ TRÊN THẺ TÁC TỬ (TRỐNG = TẤT CẢ)
      </div>
      <div className="flex flex-wrap gap-1" style={{ maxHeight: 120, overflowY: 'auto' }}>
        {toolsetCatalog.map((t) => {
          const on = newToolsets.includes(t.name)
          return (
            <button
              key={t.name}
              type="button"
              className={`vp-chip-btn${on ? ' on' : ''}`}
              disabled={creating}
              onClick={() =>
                setNewToolsets((prev) => (prev.includes(t.name) ? prev.filter((x) => x !== t.name) : [...prev, t.name]))
              }
              title={`${t.name}${t.enabled ? '' : ' (đang tắt trong bản cài này)'}`}
              style={{ opacity: t.enabled ? 1 : 0.55 }}
            >
              {on ? '✓ ' : ''}{t.name}
            </button>
          )
        })}
        {!toolsetCatalog.length && <span className="vp-muted">đang tải danh sách bộ công cụ…</span>}
      </div>
      {/*
        Toggle A2A: default MATI (opt-in). Hidup = coba tulis entri
        served-agent (local:false, dijawab profil ini sendiri). BERLAKU SETELAH
        GATEWAY DI-RESTART — form tidak menampilkan "aktif" sebelum itu.
      */}
      <label className="flex items-center gap-2" style={{ fontSize: 12 }}>
        <input
          type="checkbox"
          checked={newServeA2a}
          disabled={creating}
          onChange={(e) => setNewServeA2a(e.target.checked)}
        />
        <span title="Đăng ký hồ sơ này vào platforms.a2a.agents (local:false). Có hiệu lực sau khi khởi động lại gateway.">
          Cho phép tác tử khác liên hệ (A2A) — tự chọn bật; đăng ký cấu hình gateway vẫn tạm hoãn trong bản vá bảo mật này
        </span>
      </label>
      <button
        className="vp-btn"
        disabled={creating || !newName.trim()}
        onClick={create}
      >
        {creating ? 'Đang tạo…' : '+ Tạo hồ sơ'}
      </button>

      <button className="vp-btn vp-btn-rosy" disabled={!!busy} onClick={load}>
        Làm mới
      </button>

      {/*
        Pemetaan domain→pemilik (dipakai office, bukan A2A). Domain tanpa
        pemilik = null → TAMPILKAN "tidak ada pemilik", jangan mengarang.
      */}
      {Object.keys(domainOwners).length > 0 && (
        <>
          <div className="vp-sub">AI PHỤ TRÁCH GÌ (VĂN PHÒNG, KHÔNG PHẢI A2A)</div>
          <div className="flex flex-col gap-1">
            {Object.entries(domainOwners).map(([d, owner]) => (
              <div key={d} className="vp-kv">
                <span>{d}</span>
                <b>{owner ?? 'chưa có người phụ trách'}</b>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="vp-sub">LỌC BỘ PHẬN</div>
      <select
        className="vp-input"
        value={divFilter}
        onChange={(e) => setDivFilter(e.target.value as 'all' | AgentDivision)}
        title="Lọc danh sách tác tử theo bộ phận"
      >
        <option value="all">Tất cả</option>
        {DIVISION_OPTIONS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>

      <div className="vp-sub">TRONG VĂN PHÒNG ({inOffice.length})</div>
      <div className="flex flex-col gap-2">
        {inOffice.map((r) => (
          <div key={r.name} className="vp-agent-row">
            <div className="vp-agent-meta">
              <b>
                {r.name}
                {!r.profile && <span className="vp-tag-warn">chưa có hồ sơ</span>}
              </b>
              <i>{r.total} công việc</i>
              {badges(r)}
              {limits(r)}
              <AvatarPanel avatarId={`agent:${r.name}`} name={r.name} />
            </div>
            {/* The profile's default model: what its workers and chats run.
                Saving here writes `model.default` for that profile, so it
                applies to every future spawn — not just one task. */}
            {r.profile && (
              <div className="vp-agent-model">
                <ModelPicker
                  value={pick[r.name] ?? r.model ?? ''}
                  onChange={(model) => setPick((p) => ({ ...p, [r.name]: model }))}
                  models={models}
                  disabled={busy === r.name}
                  emptyLabel="mặc định của Hermes"
                  title="Mô hình mặc định của hồ sơ này"
                />
                <button
                  className="vp-btn"
                  disabled={busy === r.name || (pick[r.name] ?? r.model ?? '') === (r.model ?? '')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void setModel(r.name, pick[r.name] ?? '')
                  }}
                >
                  {busy === r.name ? '…' : 'Lưu'}
                </button>
              </div>
            )}
            {/* Two different things, so two different buttons, and now two
                different actions. A name with no profile on disk is an assignee
                left behind by a task whose profile was deleted — there is
                nothing to delete, and hiding it is the ONLY safe operation:
                sending it to `kill` purged its tasks permanently while the
                button said "tanpa menghapus apa pun". */}
            <div className="flex gap-2">
              <button
                className="vp-btn"
                disabled={busy === r.name}
                onClick={(e) => {
                  e.stopPropagation()
                  void act('hide', r.name)
                }}
                title="Ẩn tên này khỏi văn phòng mà không xóa dữ liệu"
              >
                {busy === r.name ? '…' : 'Ẩn'}
              </button>
              {r.profile && (
                <button
                  className={`vp-btn vp-btn-danger ${confirmKill === r.name ? 'vp-btn-armed' : ''}`}
                  disabled={busy === r.name}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirmKill !== r.name) {
                      setConfirmKill(r.name)
                      return
                    }
                    void act('kill', r.name)
                  }}
                  title="Xóa vĩnh viễn hồ sơ này, bao gồm phiên và khóa"
                >
                  {busy === r.name ? '…' : confirmKill === r.name ? 'Xác nhận xóa?' : 'Xóa vĩnh viễn'}
                </button>
              )}
            </div>
          </div>
        ))}
        {confirmKill && (
          <div className="vp-cron-err">
            Xóa <b>{confirmKill}</b> vĩnh viễn — hồ sơ, phiên, bộ nhớ, khóa,
            <b> và {inOffice.find((x) => x.name === confirmKill)?.total ?? 0} việc của tác tử</b>.
            Nhấn ra ngoài để hủy.
          </div>
        )}
        {!inOffice.length && <span className="vp-muted">trống</span>}
      </div>

      {out.length > 0 && (
        <>
          <div className="vp-sub">BÊN NGOÀI ({out.length})</div>
          <div className="flex flex-col gap-2">
            {out.map((r) => (
              <div key={r.name} className="vp-agent-row off">
                <div className="vp-agent-meta">
                  <b>
                    {r.name}
                    {!r.profile && <span className="vp-tag-warn">chưa có hồ sơ</span>}
                  </b>
                  <i>
                    {r.reason === 'hidden'
                      ? 'đã ẩn'
                      : r.reason === 'no_profile'
                        ? 'chưa có hồ sơ trên đĩa'
                        : 'chưa có việc'}
                  </i>
                  {badges(r)}
                  {limits(r)}
                  <AvatarPanel avatarId={`agent:${r.name}`} name={r.name} />
                </div>
                <button
                  className="vp-btn"
                  disabled={busy === r.name}
                  onClick={() => act('spawn', r.name)}
                  title="Tác tử đi vào qua cửa chính rồi đến bàn làm việc"
                >
                  {busy === r.name ? '…' : 'Đưa vào văn phòng'}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </FullPanel>
  )
}
