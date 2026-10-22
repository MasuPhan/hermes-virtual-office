/**
 * KENDALI — satu-satunya berkas di office ini yang MENGUBAH keadaan Hermes.
 *
 * Semua yang lain melapor. Berkas ini menekan tombol, dan itu berarti tiga aturan yang tidak
 * berlaku di tempat lain:
 *
 *   1. SETIAP aksi harus bisa dijawab "apa yang barusan terjadi". Aksi yang tidak bisa
 *      dilaporkan hasilnya lebih buruk daripada tidak ada tombol — operator akan menekannya
 *      lagi, dan lagi.
 *
 *   2. TIDAK ADA AKSI YANG DIJALANKAN SENDIRI. Semua di sini dipicu manusia, tidak ada
 *      pemanggilan otomatis dari polling. Menekan tombol yang menghentikan kerja harus
 *      keputusan, bukan efek samping.
 *
 *   3. BAHAYA DINYATAKAN SEBELUM DIJALANKAN. `describeAction` ada supaya UI bisa bilang
 *      "ini akan menghentikan SEMUA kerja baru" DULU, bukan sesudahnya.
 *
 * ESTOP: `hermes pause` menulis sentinel `$HERMES_HOME/ESTOP`; `hermes resume` menghapusnya.
 * Yang dihentikan hanya KERJA BARU — cron, dispatch kanban, dan turn gateway baru. Kerja yang
 * sedang jalan TIDAK dibunuh (dari dokumentasi `agent/estop.py`: "in-flight work is never
 * killed"). EFEK INI DIBACA DARI SENTINEL, bukan dari menjalankan perintah: membaca berkas
 * tidak bisa mengubah apa pun, jadi membuka panel tidak pernah bisa menjeda sistem.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveFleetRoot } from './root'
import type { AgentRole } from '@/types/hermes'

/** ESTOP lives at the explicit fleet root, not a named-profile home. */
export function estopPath(): string {
  return join(resolveFleetRoot(process.env), 'ESTOP')
}

/** Aksi yang boleh diminta dari UI. Daftar tertutup — bukan string bebas. */
export type ActionKind =
  /** Hentikan SEMUA kerja baru. Cron, dispatch kanban, turn gateway baru. */
  | 'pauseAll'
  /** Jalankan lagi. */
  | 'resumeAll'
  /** Buka blokir satu task, dengan alasan yang diketik operator. */
  | 'unblock'
  /** Kembalikan task ke ready supaya dispatcher bisa mengambilnya. */
  | 'promote'
  /** Lepaskan worker yang memegang task — untuk worker yang sudah mati. */
  | 'release'
  /** Pasang chain cadangan provider. Mengubah perilaku SELURUH instalasi. */
  | 'setFallback'

export type ActionRequest = {
  action: ActionKind
  /** Task id, untuk aksi yang menyasar satu task. */
  taskId?: string
  /** Alasan, untuk aksi yang membutuhkannya. Yang menghentikan kerja WAJIB memberi alasan. */
  reason?: string
}

/* ------------------------------------------------------------------ izin -- */

/**
 * Apakah sebuah permintaan boleh dijalankan, dan kalau tidak, kenapa.
 *
 * Dipisah dari pelaksanaannya supaya bisa diuji tanpa menjalankan apa pun — dan itu penting
 * untuk berkas yang menekan tombol berbahaya: aturannya harus bisa diperiksa tanpa risikonya.
 */
export type Verdict = { allowed: true } | { allowed: false; why: string }

export function checkAction(req: ActionRequest): Verdict {
  const needsTask: ActionKind[] = ['unblock', 'promote', 'release']
  if (needsTask.includes(req.action)) {
    if (!req.taskId || !/^t_[0-9a-f]{8}$/.test(req.taskId)) {
      return { allowed: false, why: `${req.action} cần ID công việc hợp lệ` }
    }
  }
  // Menghentikan kerja SELURUH SISTEM wajib punya alasan. Tanpa itu, catatannya cuma
  // "seseorang menjeda semuanya" — dan di situlah orang berdebat nanti.
  if (req.action === 'pauseAll') {
    const r = (req.reason || '').trim()
    if (r.length < 3) return { allowed: false, why: 'Phải nêu lý do khi dừng toàn bộ công việc' }
  }
  // Membuka blokir juga wajib beralasan: itu catatan kenapa blokirnya dicabut, dan di papan
  // ia muncul sebagai komentar yang bisa dibaca ulang.
  if (req.action === 'unblock') {
    const r = (req.reason || '').trim()
    if (r.length < 3) return { allowed: false, why: 'Phải nêu lý do khi bỏ chặn' }
  }
  return { allowed: true }
}

/* -------------------------------------------------------- izin per agent -- */

/**
 * Aksi yang bisa diminta ATAS NAMA sebuah agent. Daftar tertutup, sama seperti `ActionKind`.
 *
 *   pauseAll — hentikan seluruh kerja baru (ESTOP).
 *   spawn    — ubah siapa yang ada di kantor (spawn / sembunyikan).
 *   kill     — hapus profil agent beserta tugasnya.
 *   create   — buat profil agent baru.
 *   setModel — ganti model bawaan profil agent.
 *   steer    — kirim arahan ke worker yang memegang satu task.
 *   advance  — gerakkan satu task: unblock / promote / release.
 */
export type AgentActionKind = 'pauseAll' | 'spawn' | 'kill' | 'create' | 'setModel' | 'steer' | 'advance'

export const AGENT_ACTIONS: AgentActionKind[] = ['pauseAll', 'spawn', 'kill', 'create', 'setModel', 'steer', 'advance']

export const AGENT_ACTION_LABEL: Record<AgentActionKind, string> = {
  pauseAll: 'Tạm dừng tất cả',
  spawn: 'Hiện/ẩn tác tử',
  kill: 'Xóa tác tử',
  create: 'Tạo hồ sơ',
  setModel: 'Đổi mô hình',
  steer: 'Chỉ dẫn công việc',
  advance: 'Chuyển công việc',
}

export type AgentPermission = {
  /** Aksi yang boleh. Yang tidak ada di sini dan tidak ada di `deny` tetap DITOLAK. */
  allow: AgentActionKind[]
  /** Aksi yang ditolak, masing-masing dengan alasannya sendiri — bukan pesan generik. */
  deny: Partial<Record<AgentActionKind, string>>
  /** false = steer/advance hanya untuk task milik agent itu sendiri. */
  anyTask: boolean
}

const STAFF: AgentPermission = {
  allow: ['steer', 'advance'],
  deny: {
    pauseAll: 'Tác tử nhân viên không được dừng toàn hệ thống — chỉ người vận hành hoặc bộ điều phối được quyết định tạm dừng tất cả',
    spawn: 'Tác tử nhân viên không được thay đổi thành viên trong văn phòng — hiện/ẩn đồng nghiệp là nhiệm vụ điều phối',
    kill: 'Tác tử nhân viên không được xóa tác tử khác — kill xóa vĩnh viễn hồ sơ cùng toàn bộ công việc',
    create: 'Tác tử nhân viên không được tạo hồ sơ tác tử mới — thêm thành viên là quyết định của bộ điều phối',
    setModel: 'Tác tử nhân viên không được đổi mô hình của hồ sơ — việc đó thay đổi chi phí và hành vi của tác tử khác',
  },
  anyTask: false,
}

/**
 * TABEL IZIN PER ROLE — satu-satunya tempat aturan ini hidup. Route dan UI membaca dari sini.
 *
 * Orkestrasi (ceo/orchestrator) boleh semua aksi dan boleh menyentuh task siapa pun, karena
 * membagi dan menggerakkan kerja orang lain memang tugasnya. Manager memimpin satu divisi:
 * boleh mengatur anggota dan task, tapi tidak menghentikan SELURUH sistem dan tidak menghapus
 * agent. Jeda semua tetap tunduk pada `checkAction` (wajib beralasan) — tabel ini tidak
 * pernah melonggarkannya.
 */
export const AGENT_PERMISSIONS: Record<AgentRole, AgentPermission> = {
  ceo: { allow: [...AGENT_ACTIONS], deny: {}, anyTask: true },
  orchestrator: { allow: [...AGENT_ACTIONS], deny: {}, anyTask: true },
  manager: {
    allow: ['spawn', 'create', 'setModel', 'steer', 'advance'],
    deny: {
      pauseAll: 'Quản lý phụ trách một bộ phận — dừng TOÀN BỘ hệ thống là quyết định của ceo/orchestrator',
      kill: 'Quản lý không được xóa tác tử — kill xóa vĩnh viễn hồ sơ và công việc; hãy yêu cầu ceo/orchestrator',
    },
    anyTask: true,
  },
  backend: STAFF,
  frontend: STAFF,
  qa: STAFF,
  researcher: STAFF,
  devops: STAFF,
  marketing: STAFF,
  seo: STAFF,
  content: STAFF,
  affiliator: STAFF,
}

export type AgentActionRequest = {
  agent: string
  role: AgentRole
  action: AgentActionKind
  taskId?: string
  /** Pemilik task yang disasar; null = task tanpa pemilik, undefined = tidak diketahui. */
  taskAssignee?: string | null
  reason?: string
}

/**
 * Apakah sebuah agent boleh meminta aksi ini. Fungsi MURNI, sama seperti `checkAction`.
 *
 * Urutannya: identitas → tabel role → kepemilikan task → aturan operator lama (`checkAction`).
 * Aturan lama SELALU ikut dinilai di ujung, jadi izin per agent hanya bisa MENAMBAH larangan.
 */
export function checkAgentAction(req: AgentActionRequest): Verdict {
  const agent = (req.agent || '').trim()
  if (!agent) return { allowed: false, why: 'Thao tác thay mặt tác tử cần có tên tác tử' }
  const perm = (AGENT_PERMISSIONS as Record<string, AgentPermission | undefined>)[req.role]
  if (!perm) return { allowed: false, why: `Vai trò "${req.role}" không xác định — không được cấp quyền` }
  if (!AGENT_ACTIONS.includes(req.action)) {
    return { allowed: false, why: `Thao tác "${req.action}" không xác định` }
  }
  const denied = perm.deny[req.action]
  if (denied) return { allowed: false, why: `${agent}: ${denied}` }
  if (!perm.allow.includes(req.action)) {
    return { allowed: false, why: `${agent}: thao tác "${req.action}" không nằm trong danh sách quyền của vai trò ${req.role}` }
  }

  if (req.action === 'steer' || req.action === 'advance') {
    if (!req.taskId || !/^t_[0-9a-f]{8}$/.test(req.taskId)) {
      return { allowed: false, why: `${req.action} cần ID công việc hợp lệ` }
    }
    if (!perm.anyTask) {
      if (req.taskAssignee === undefined) {
        return { allowed: false, why: `${agent}: người phụ trách ${req.taskId} chưa xác định — chỉ được thao tác trên công việc của chính mình` }
      }
      if (req.taskAssignee !== agent) {
        const owner = req.taskAssignee ? `thuộc về ${req.taskAssignee}` : 'Không có người phụ trách'
        return { allowed: false, why: `${agent}: ${req.taskId} ${owner}, không thuộc về ${agent} — vai trò ${req.role} chỉ được thao tác trên công việc của chính mình` }
      }
    }
  }

  // Aturan operator lama tetap berlaku untuk agent: jeda semua wajib beralasan.
  if (req.action === 'pauseAll') return checkAction({ action: 'pauseAll', reason: req.reason })
  return { allowed: true }
}

/** Ringkasan tabel untuk UI: label "boleh" dan "tidak boleh" per role. */
export function agentPermissionSummary(): Record<AgentRole, { allow: string[]; deny: string[]; anyTask: boolean }> {
  const out = {} as Record<AgentRole, { allow: string[]; deny: string[]; anyTask: boolean }>
  for (const [role, p] of Object.entries(AGENT_PERMISSIONS) as [AgentRole, AgentPermission][]) {
    out[role] = {
      allow: p.allow.map((a) => AGENT_ACTION_LABEL[a]),
      deny: AGENT_ACTIONS.filter((a) => !p.allow.includes(a)).map((a) => AGENT_ACTION_LABEL[a]),
      anyTask: p.anyTask,
    }
  }
  return out
}

/**
 * Apa yang akan terjadi kalau aksi ini dijalankan — untuk ditampilkan SEBELUM tombolnya ditekan.
 *
 * `danger: true` berarti UI wajib memakai konfirmasi dua langkah (pola yang sudah dipakai
 * CronPanel). Tombol yang mengubah keadaan tidak boleh selesai dalam satu klik nyasar.
 */
export type ActionEffect = {
  label: string
  /** Apa yang terjadi pada kerja yang SEDANG jalan. Ini yang paling sering disalahpahami. */
  effect: string
  danger: boolean
}

export const ACTION_EFFECT: Record<ActionKind, ActionEffect> = {
  pauseAll: {
    label: 'Tạm dừng tất cả',
    effect: 'Dừng công việc MỚI: cron, điều phối kanban, lượt gateway mới. KHÔNG chấm dứt công việc đang chạy.',
    danger: true,
  },
  resumeAll: {
    label: 'Tiếp tục',
    effect: 'Tiếp tục điều phối vào nhịp tiếp theo.',
    danger: false,
  },
  unblock: {
    label: 'Bỏ chặn',
    effect: 'Đưa công việc trở lại bảng và ghi lý do vào bình luận.',
    danger: false,
  },
  promote: {
    label: 'Chuyển sang sẵn sàng',
    effect: 'Đưa công việc về ready để bộ điều phối có thể nhận.',
    danger: false,
  },
  setFallback: {
    label: 'Thiết lập nhà cung cấp dự phòng',
    effect:
      'Ghi chuỗi dự phòng vào config.yaml sau khi sao lưu tệp. Việc này thay đổi nhà cung cấp cho TOÀN BỘ bản cài đặt, kể cả tác tử đang làm việc.',
    danger: true,
  },
  release: {
    label: 'Giải phóng worker',
    effect: 'Giải phóng worker đang giữ công việc. Dùng khi worker đã dừng nhưng công việc vẫn được ghi nhận là đang chạy.',
    danger: true,
  },
}

/* ------------------------------------------------------------------ ESTOP -- */

export type PauseState = {
  paused: boolean
  reason: string | null
  engagedAt: string | null
}

/**
 * Apakah sistem sedang dijeda.
 *
 * Dibaca dari BERKAS, bukan dari perintah. Dua alasan: membaca tidak bisa mengubah apa pun
 * (jadi panel yang memanggil ini tidak mungkin menjeda sistem), dan berkas yang rusak/ kosong
 * tetap dihitung JEDA — perilaku yang sama dengan Hermes, "fail safe".
 */
export function readPause(): PauseState {
  const estop = estopPath()
  if (!existsSync(estop)) return { paused: false, reason: null, engagedAt: null }
  try {
    const raw = readFileSync(estop, 'utf8').trim()
    if (!raw) return { paused: true, reason: null, engagedAt: null }
    const j = JSON.parse(raw) as { reason?: string; engaged_at?: string }
    return { paused: true, reason: j.reason ?? null, engagedAt: j.engaged_at ?? null }
  } catch {
    // Berkas tidak terbaca atau bukan JSON: tetap JEDA. Kesalahan membaca tidak boleh
    // mengubah "berhenti" jadi "jalan".
    return { paused: true, reason: null, engagedAt: null }
  }
}

/* ESTOP_PATH removed: use estopPath() so the fleet root is resolved per call. */
