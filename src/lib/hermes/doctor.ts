/**
 * DOCTOR "Siap pakai?" — pemeriksaan menyeluruh sebelum pengguna baru bingung.
 * (nama bersejarah panel UI yang sudah dihapus; mesin doctor tetap hidup
 * sebagai API GET /api/hermes/doctor + POST /api/hermes/selfrepair).
 *
 * Kenapa file ini ada: kantor 3D-nya jalan, tapi tombol bisa gagal diam-diam
 * (rapat ditolak, A2A tidak nyala, chat gagal tanpa model). Doctor
 * memeriksa tiap lapisan dan mengembalikan lulus/gagal + langkah perbaikan
 * (string fix menunjuk endpoint selfrepair, bukan panel).
 *
 * ATURAN JUJUR (sama seperti SystemPanel): yang tidak bisa dipastikan bilang
 * "tidak bisa dipastikan" (status 'unknown') — JANGAN lampu hijau untuk yang
 * cuma "kelihatannya beres".
 *
 * Fungsi pure (parseA2aPlatform, classifyServed, parseGatewayStart,
 * needsRestart, originVerdict) dipisah supaya selftest menguji tanpa CLI.
 */

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { isTrustedHost, isTrustedOrigin } from '../local-guard'
import { fleetRootEnv } from './root'
import { errorTail } from './redact'

const run = promisify(execFile)

const HERMES_BIN = process.env.HERMES_BIN || 'hermes'
const TIMEOUT_MS = Number(process.env.KANBAN_TIMEOUT_MS || 20_000)

export type DoctorStatus = 'pass' | 'fail' | 'unknown'

export type DoctorCheck = {
  id: string
  label: string
  status: DoctorStatus
  /** Fakta apa adanya (angka, nama, pesan error asli). */
  detail: string
  /** Langkah perbaikan yang bisa disalin. Kosong bila lulus. */
  fix: string
}

export type DoctorReport = {
  readAt: string
  hermesBin: string
  checks: DoctorCheck[]
}

/**
 * MODEL-PROVIDER-1: klasifikasi pure "provider menggantung".
 *
 * `model.provider: custom:<nama>` hanya hidup bila definisi `custom_providers`
 * bernama `<nama>` ada DI SCOPE PROFIL ITU (bukan cuma global). Tanpa itu chat
 * mati dengan "Unknown provider" walau model default terisi.
 *
 * - provider non-custom (null, "openai", ...) = 'ok' (di luar urusan blok ini).
 * - definisi tak terbaca (null) = 'unknown' (jujur, bukan lulus).
 * - custom tanpa definisi cocok = 'dangling' (rusak).
 * - custom dengan definisi cocok = 'ok'.
 */
export function classifyProviderScope(
  provider: string | null,
  defs: { name?: string }[] | null,
): 'ok' | 'dangling' | 'unknown' {
  const pv = (provider || '').trim()
  if (!pv.toLowerCase().startsWith('custom:')) return 'ok'
  const need = pv.slice('custom:'.length).trim().toLowerCase()
  if (defs === null) return 'unknown'
  const have = (defs || []).some((d) => String(d?.name || '').trim().toLowerCase() === need)
  return have ? 'ok' : 'dangling'
}

/** Env tanpa penanda sesi agent — sama kontraknya dengan cleanEnv() di kanban.ts. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = fleetRootEnv(process.env)
  for (const k of [
    'HERMES_DELEGATED_CHILD_CONTEXT',
    'HERMES_SUPERVISED_CHILD',
    'HERMES_SESSION_ID',
    'HERMES_SESSION_PLATFORM',
    'HERMES_SESSION_CHAT_ID',
    'HERMES_SESSION_USER_ID',
  ]) {
    delete env[k]
  }
  return env
}

/* ---------------------------------------------------------------- pure --- */

/**
 * Hasil `hermes config get platforms.a2a --json` → { found, enabled, port }.
 * found=false = kunci belum ada sama sekali (bukan "mati" — beda perbaikannya).
 */
export function parseA2aPlatform(raw: unknown): {
  found: boolean
  enabled: boolean
  port: number | null
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { found: false, enabled: false, port: null }
  }
  const r = raw as { enabled?: unknown; port?: unknown }
  const port = typeof r.port === 'number' && Number.isFinite(r.port) ? r.port : null
  return { found: true, enabled: r.enabled === true, port }
}

/**
 * Entri served yang profilnya sudah tidak ada = BASI: tercatat tapi tidak
 * akan pernah menjawab. Basi ditandai, bukan dihitung sebagai siap.
 */
export function classifyServed(
  served: { profile: string; slug: string }[],
  profiles: string[],
): { profile: string; slug: string; stale: boolean }[] {
  const have = new Set(profiles.map((p) => p.trim().toLowerCase()))
  return served.map((s) => ({
    profile: s.profile,
    slug: s.slug,
    stale: !have.has(s.profile.trim().toLowerCase()),
  }))
}

/**
 * `systemctl --user show hermes-gateway -p ActiveEnterTimestamp --value`
 * menjawab "Thu 2026-10-08 22:44:31 WIB". Sufiks zona ("WIB") dibuang —
 * Date.parse tidak mengenalnya — sisanya dibaca sebagai waktu lokal server.
 * Tak terparse = null = "tidak bisa dipastikan", bukan 0.
 */
export function parseGatewayStart(out: string): number | null {
  const line = out.trim().split('\n').pop()?.trim() ?? ''
  if (!line || line === 'ActiveEnterTimestamp=') return null
  const cleaned = line
    .replace(/^ActiveEnterTimestamp=/, '')
    .replace(/\s+[A-Z]{2,5}$/, '')
    .trim()
  const t = Date.parse(cleaned)
  return Number.isFinite(t) ? t : null
}

/**
 * Daftar served dibaca SEKALI saat gateway boot: config lebih baru dari
 * start gateway = entri baru tersimpan tapi belum aktif.
 * gatewayStartMs null = start tak diketahui → null (tidak bisa dipastikan).
 */
export function needsRestart(configMtimeMs: number, gatewayStartMs: number | null): boolean | null {
  if (gatewayStartMs === null) return null
  return configMtimeMs > gatewayStartMs
}

/**
 * Putusan tulis untuk Host/Origin peminta (cermin read-only doctor).
 *
 * Logikanya sama dengan local-guard.ts (itu yang dipakai route tulis —
 * ini cermin read-only untuk ditampilkan). allowedRaw = isi mentah
 * ALLOWED_ORIGINS (koma, boleh pakai skema).
 *
 * Tanpa header Origin (fetch server-ke-server, curl) = 'unknown': doctor
 * tidak bisa tahu browser akan mengirim apa — bilang begitu, bukan lulus.
 */
export function originVerdict(
  hostHeader: string | null,
  originHeader: string | null,
  allowedRaw: string,
): { status: DoctorStatus; detail: string; fix: string } {
  if (!hostHeader || !originHeader) {
    return {
      status: 'unknown',
      detail: 'Không thể xác định — yêu cầu thiếu header Origin (curl/máy chủ với máy chủ; mở bằng trình duyệt để có kết quả chắc chắn)',
      fix: '',
    }
  }
  if (!isTrustedHost(hostHeader, allowedRaw)) {
    return {
      status: 'fail',
      detail: `Host "${hostHeader}" không phải loopback và không nằm trong ALLOWED_ORIGINS`,
      fix: `Thêm "${hostHeader}" vào ALLOWED_ORIGINS trong .env.local rồi khởi động lại`,
    }
  }
  if (!isTrustedOrigin(hostHeader, originHeader, allowedRaw)) {
    return {
      status: 'fail',
      detail: `Origin "${originHeader}" không khớp chính xác (giao thức/host/cổng) với Host/ALLOWED_ORIGINS — yêu cầu ghi sẽ nhận mã 403`,
      fix: `Mở văn phòng qua cùng origin hoặc thêm chính xác origin đó vào ALLOWED_ORIGINS`,
    }
  }
  return { status: 'pass', detail: `Origin "${originHeader}" trùng với Host và đáng tin cậy`, fix: '' }
}

/**
 * Kemampuan MEMANGGIL satu profil: `platform_toolsets.cli` memuat `a2a`.
 * null = tak terbaca (bedakan dari false = terbaca tapi tak punya).
 * Dipisah murni supaya selftest + SELFREPAIR-1 memakai logika yang SAMA
 * (jangan bikin logika kedua).
 */
export function canCall(toolsets: string[] | null): boolean | null {
  if (toolsets === null) return null
  return toolsets.some((t) => String(t).trim().toLowerCase() === 'a2a')
}

/**
 * Fallthrough A2A: path tak dikenal HARUS ditolak bernada "no agent is served".
 * answered=true + bunyi itu = server menampung path asing ke agent default
 * (bug fallthrough — tambalan Hermes bisa hilang saat update).
 */
export function fallthroughVerdict(httpOk: boolean, body: string): {
  status: DoctorStatus
  detail: string
} {
  if (!httpOk) {
    return {
      status: 'pass',
      detail: 'Đường dẫn không xác định bị từ chối ở tầng HTTP (không được tác tử trả lời)',
    }
  }
  if (/no agent is served at/i.test(body)) {
    return {
      status: 'pass',
      detail: 'Đường dẫn không xác định bị từ chối đúng thực tế ("no agent is served") — không chuyển về tác tử mặc định',
    }
  }
  return {
    status: 'fail',
    detail: `Đường dẫn không xác định ĐƯỢC TRẢ LỜI (chuyển về tác tử mặc định?) — phản hồi: ${body.slice(0, 160)}`,
  }
}

/* ---------------------------------------------------------------- live --- */

/**
 * Start gateway lewat `systemctl --user show`. Office jalan sebagai service
 * SISTEM (tanpa user bus), jadi argv systemctl butuh XDG_RUNTIME_DIR=/run/user/0
 * — tanpa itu stdout kosong dan start "tak terbaca" padahal gateway hidup.
 * Bila systemctl tetap gagal, fallback: PID di gateway.pid → waktu start
 * proses itu (Platform M = restart tak terdeteksi hanya bila keduanya gagal).
 */
export async function gatewayStartMs(): Promise<number | null> {
  const env = { ...cleanEnv(), XDG_RUNTIME_DIR: '/run/user/0' }
  try {
    const { stdout } = await run(
      'systemctl',
      ['--user', 'show', 'hermes-gateway', '-p', 'ActiveEnterTimestamp', '--value'],
      { env, timeout: 10_000, maxBuffer: 64 * 1024 },
    )
    const t = parseGatewayStart(stdout)
    if (t !== null) return t
  } catch {
    // jatuh ke fallback PID di bawah
  }
  try {
    const { hermesHome } = await import('./kanban')
    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const raw = await readFile(path.join(hermesHome(), 'gateway.pid'), 'utf8')
    const pid = Number(JSON.parse(raw)?.pid)
    if (Number.isFinite(pid) && pid > 0) {
      const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: cleanEnv(),
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      })
      const t = Date.parse(stdout.trim())
      if (Number.isFinite(t)) return t
    }
  } catch {
    // dua-duanya gagal = benar-benar tak bisa dipastikan
  }
  return null
}

export async function runDoctor(opts: { host: string | null; origin: string | null }): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []

  // 1. Hermes CLI ketemu & bisa dipanggil.
  let cliOk = false
  let cliVersion = ''
  try {
    const { stdout } = await run(HERMES_BIN, ['--version'], {
      env: cleanEnv(),
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    cliOk = true
    cliVersion = stdout.trim().split('\n')[0].slice(0, 80)
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    checks.push({
      id: 'cli',
      label: 'Tìm thấy Hermes CLI và có thể gọi',
      status: 'fail',
      detail:
        e.code === 'ENOENT'
          ? `Không có tệp thực thi tại "${HERMES_BIN}"`
          : `Không thể chạy "${HERMES_BIN}": ${errorTail(e, 300)}`,
      fix: `Đặt HERMES_BIN trỏ đến đường dẫn tệp thực thi hermes (hiện tại: "${HERMES_BIN}")`,
    })
  }
  if (cliOk) {
    checks.push({
      id: 'cli',
      label: 'Tìm thấy Hermes CLI và có thể gọi',
      status: 'pass',
      detail: `"${HERMES_BIN}" phản hồi: ${cliVersion || '(không có phiên bản)'}`,
      fix: '',
    })
  }

  // Modul berat diimpor malas: kalau CLI mati, doctor tetap bisa menilai
  // origin tanpa menarik seluruh jembatan kanban.
  const { listProfiles, listTasks, profileModel, profileCustomProviders, hermesHome } = await import('./kanban')
  const { isConfigured } = await import('./meeting')
  const { listServedAgents } = await import('./a2a-served')

  // 2. Board bisa dibaca.
  let taskCount: number | null = null
  try {
    const tasks = await listTasks()
    taskCount = tasks.length
    checks.push({
      id: 'board',
      label: 'Đọc được bảng công việc',
      status: 'pass',
      detail: `${tasks.length} công việc đọc được qua CLI`,
      fix: '',
    })
  } catch (err) {
    checks.push({
      id: 'board',
      label: 'Đọc được bảng công việc',
      status: 'fail',
      detail: (err as Error).message.slice(0, 300),
      fix: 'Khắc phục đúng lỗi phía trên — thường do HERMES_BIN hoặc bảng được chỉ định bởi HERMES_KANBAN_BOARD',
    })
  }

  // 3. Profil agent ada.
  let profiles: string[] | null = null
  try {
    profiles = await listProfiles()
    if (!profiles.length) {
      checks.push({
        id: 'profiles',
        label: 'Có hồ sơ tác tử',
        status: 'fail',
        detail: 'Chưa có hồ sơ nào',
        fix: 'Tạo từ biểu mẫu Tác tử hoặc chạy: hermes profile create <nama> --no-alias',
      })
    } else {
      checks.push({
        id: 'profiles',
        label: 'Có hồ sơ tác tử',
        status: 'pass',
        detail: `${profiles.length} hồ sơ: ${profiles.slice(0, 8).join(', ')}${profiles.length > 8 ? ` (+${profiles.length - 8})` : ''}`,
        fix: '',
      })
    }
  } catch (err) {
    checks.push({
      id: 'profiles',
      label: 'Có hồ sơ tác tử',
      status: 'fail',
      detail: (err as Error).message.slice(0, 300),
      fix: 'Tạo từ biểu mẫu Tác tử hoặc chạy: hermes profile create <nama> --no-alias',
    })
  }

  // 4. Profil punya model (tanpa model, chat gagal).
  if (!profiles) {
    checks.push({
      id: 'models',
      label: 'Hồ sơ có mô hình',
      status: 'unknown',
      detail: 'Không thể xác định — không đọc được danh sách hồ sơ',
      fix: '',
    })
  } else if (!profiles.length) {
    checks.push({
      id: 'models',
      label: 'Hồ sơ có mô hình',
      status: 'unknown',
      detail: 'Không thể xác định — không có hồ sơ để kiểm tra',
      fix: '',
    })
  } else {
    const models = await Promise.all(profiles.map(async (p) => ({ p, ...(await profileModel(p)) })))
    // NOTE: `models` also feeds the dangling-provider verdict below — keep the
    // two loops over the same snapshot, not two separate reads.
    const missing = models.filter((m) => !m.model).map((m) => m.p)
    if (!missing.length) {
      checks.push({
        id: 'models',
        label: 'Hồ sơ có mô hình',
        status: 'pass',
        detail: `Toàn bộ ${profiles.length} hồ sơ có mô hình mặc định`,
        fix: '',
      })
    } else {
      checks.push({
        id: 'models',
        label: 'Hồ sơ có mô hình',
        status: 'fail',
        detail: `Chưa có mô hình: ${missing.join(', ')} — trò chuyện với các tác tử này sẽ thất bại`,
        fix: `Chọn mô hình cho từng hồ sơ (bộ chọn trong biểu mẫu Tác tử) hoặc chạy: hermes -p <nama> config set model.default <model>`,
      })
    }
    // Provider menggantung: `model.provider: custom:<nama>` tanpa definisi
    // `custom_providers` bernama itu di scope profil = chat mati dengan
    // "Unknown provider", walau model default ADA. Periksa lama lulus untuk
    // kasus ini — sekarang gagal jujur + langkah perbaikan yang bisa disalin.
    const customNames = models
      .map((m) => {
        const pv = (m.provider || '').trim()
        return pv.toLowerCase().startsWith('custom:') ? pv.slice('custom:'.length).trim().toLowerCase() : null
      })
      .filter((n): n is string => !!n)
    if (customNames.length) {
      const defs = await Promise.all(profiles.map(async (p) => ({ p, defs: await profileCustomProviders(p) })))
      const dangling: string[] = []
      const unreadable: string[] = []
      for (const m of models) {
        const row = defs.find((d) => d.p === m.p)
        const verdict = classifyProviderScope(m.provider, row?.defs ?? null)
        // row hilang = profil lenyap di tengah baca: tak bisa dipastikan.
        if (!row) {
          unreadable.push(m.p)
        } else if (verdict === 'dangling') {
          dangling.push(`${m.p} (Nhà cung cấp "${(m.provider || '').trim()}" chưa có định nghĩa)`)
        } else if (verdict === 'unknown') {
          unreadable.push(m.p)
        }
      }
      if (dangling.length) {
        checks.push({
          id: 'model-providers',
          label: 'Xác định được nhà cung cấp mô hình',
          status: 'fail',
          detail: `Nhà cung cấp chưa có định nghĩa: ${dangling.join(', ')} — không thể trò chuyện với các tác tử này ("Unknown provider")`,
          fix: `TỰ TẠO định nghĩa nhà cung cấp tương ứng trong phạm vi hồ sơ bằng thông tin xác thực thật của bạn (không sao chép đầu ra config-get đã che api_key). Tính năng sao chép tự động đã tắt trong bản vá này.`,
        })
      } else if (unreadable.length) {
        checks.push({
          id: 'model-providers',
          label: 'Xác định được nhà cung cấp mô hình',
          status: 'unknown',
          detail: `Không thể xác định — không đọc được định nghĩa nhà cung cấp của: ${unreadable.join(', ')}`,
          fix: '',
        })
      } else {
        checks.push({
          id: 'model-providers',
          label: 'Xác định được nhà cung cấp mô hình',
          status: 'pass',
          detail: `Toàn bộ nhà cung cấp tùy chỉnh (${[...new Set(customNames)].join(', ')}) đều có định nghĩa trong phạm vi từng hồ sơ`,
          fix: '',
        })
      }
    }
  }

  // 5. Provider LLM untuk rapat simulasi.
  if (isConfigured()) {
    checks.push({
      id: 'simulasi',
      label: 'Nhà cung cấp LLM cho cuộc họp mô phỏng',
      status: 'pass',
      detail: 'Đã có AI_BASE_URL + AI_API_KEY — có thể chạy cuộc họp mô phỏng',
      fix: '',
    })
  } else {
    checks.push({
      id: 'simulasi',
      label: 'Nhà cung cấp LLM cho cuộc họp mô phỏng',
      status: 'fail',
      detail: 'AI_BASE_URL/AI_API_KEY trống — cuộc họp mô phỏng sẽ báo chưa được cấu hình',
      fix: 'Điền AI_BASE_URL + AI_API_KEY vào .env.local (xem .env.example). Cuộc họp a2a KHÔNG cần các giá trị này — tác tử thật sẽ phát biểu.',
    })
  }

  // 6. Platform A2A nyala.
  let a2aEnabled = false
  try {
    const { stdout } = await run(HERMES_BIN, ['config', 'get', 'platforms.a2a', '--json'], {
      env: cleanEnv(),
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    const start = stdout.search(/[[{]/)
    const parsed = parseA2aPlatform(start < 0 ? null : JSON.parse(stdout.slice(start)))
    if (!parsed.found || !parsed.enabled) {
      checks.push({
        id: 'a2a-platform',
        label: 'Nền tảng A2A đang bật',
        status: 'fail',
        detail: parsed.found ? 'Đã có platforms.a2a nhưng enabled không phải true' : 'Chưa có platforms.a2a trong cấu hình Hermes',
        fix: 'hermes config set platforms.a2a.enabled true --force\nhermes config set platforms.a2a.port 9900 --force\nrồi khởi động lại gateway',
      })
    } else if (parsed.port === null) {
      checks.push({
        id: 'a2a-platform',
        label: 'Nền tảng A2A đang bật',
        status: 'fail',
        detail: 'enabled là true nhưng không đọc được port',
        fix: 'hermes config set platforms.a2a.port 9900 --force\nrồi khởi động lại gateway',
      })
    } else {
      a2aEnabled = true
      checks.push({
        id: 'a2a-platform',
        label: 'Nền tảng A2A đang bật',
        status: 'pass',
        detail: `Đã bật, cổng ${parsed.port} (không có token, máy chủ chỉ lắng nghe trên loopback)`,
        fix: '',
      })
    }
  } catch (err) {
    checks.push({
      id: 'a2a-platform',
      label: 'Nền tảng A2A đang bật',
      status: 'unknown',
      detail: `Không thể xác định — không đọc được cấu hình: ${(err as Error).message.slice(0, 200)}`,
      fix: '',
    })
  }

  // 7. Agen yang di-serve (entri basi ditandai, bukan dihitung siap).
  if (!profiles) {
    checks.push({
      id: 'served',
      label: 'Tác tử được đăng ký phục vụ',
      status: 'unknown',
      detail: 'Không thể xác định — không đọc được danh sách hồ sơ, chưa thể đánh giá mục lỗi thời',
      fix: '',
    })
  } else {
    try {
      const served = await listServedAgents()
      const rows = classifyServed(served, profiles)
      const fresh = rows.filter((r) => !r.stale)
      const stale = rows.filter((r) => r.stale)
      const wrongLocal = served.filter((s) => s.local !== false)
      const detail: string[] = []
      if (fresh.length) detail.push(`Sẵn sàng: ${fresh.map((r) => r.profile).join(', ')}`)
      if (stale.length) detail.push(`LỖI THỜI (hồ sơ đã mất): ${stale.map((r) => r.profile).join(', ')}`)
      if (wrongLocal.length) detail.push(`local:true (sai danh tính): ${wrongLocal.map((s) => s.profile).join(', ')}`)
      if (!served.length) detail.push('Chưa có tác tử nào được đăng ký phục vụ')
      if (stale.length || wrongLocal.length || !fresh.length) {
        const fixes: string[] = []
        if (!fresh.length) fixes.push('Đăng ký tác tử qua công tắc A2A trong biểu mẫu Tác tử (ứng dụng ghi local:false)')
        if (stale.length) fixes.push(`Gỡ mục lỗi thời: ${stale.map((r) => r.profile).join(', ')} (tắt công tắc trong biểu mẫu Tác tử)`)
        if (wrongLocal.length) fixes.push('local PHẢI là false — true nghĩa là phiên gateway chung trả lời, sai danh tính tác tử')
        if (a2aEnabled && fresh.length) fixes.push('rồi khởi động lại gateway (danh sách đăng ký phục vụ chỉ được đọc một lần lúc khởi động)')
        checks.push({
          id: 'served',
          label: 'Tác tử được đăng ký phục vụ',
          status: 'fail',
          detail: detail.join(' · '),
          fix: fixes.join('\n'),
        })
      } else {
        const platformNote = a2aEnabled ? '' : ' — chưa xác minh nền tảng A2A đang bật (xem kiểm tra phía trên)'
        checks.push({
          id: 'served',
          label: 'Tác tử được đăng ký phục vụ',
          status: 'pass',
          detail: `${fresh.length} sẵn sàng: ${fresh.map((r) => r.profile).join(', ')}${platformNote}`,
          fix: '',
        })
      }
    } catch (err) {
      checks.push({
        id: 'served',
        label: 'Tác tử được đăng ký phục vụ',
        status: 'unknown',
        detail: `Không thể xác định — không đọc được danh sách đăng ký phục vụ: ${(err as Error).message.slice(0, 200)}`,
        fix: '',
      })
    }
  }

  // 8. Butuh restart gateway? (mtime config.yaml vs start gateway —
  // helper gatewayStartMs menangani service sistem tanpa user bus).
  try {
    const home = hermesHome()
    const mtime = (await stat(`${home}/config.yaml`)).mtimeMs
    const startMs = await gatewayStartMs()
    const need = needsRestart(mtime, startMs)
    if (need === null) {
      checks.push({
        id: 'restart',
        label: 'Cần khởi động lại gateway?',
        status: 'unknown',
        detail: 'Không thể xác định — không đọc được thời điểm khởi động gateway (không phải dịch vụ người dùng systemd?)',
        fix: 'Đảm bảo gateway chạy dưới dạng dịch vụ người dùng hermes-gateway hoặc tự khởi động lại sau mỗi lần đổi danh sách đăng ký phục vụ',
      })
    } else if (need) {
      checks.push({
        id: 'restart',
        label: 'Cần khởi động lại gateway?',
        status: 'fail',
        detail: 'config.yaml mới hơn thời điểm khởi động gateway — các mục đã lưu nhưng CHƯA có hiệu lực',
        fix: 'Đã lưu, chưa có hiệu lực — khởi động lại gateway:\nhermes gateway restart',
      })
    } else {
      checks.push({
        id: 'restart',
        label: 'Cần khởi động lại gateway?',
        status: 'pass',
        detail: 'gateway khởi động sau lần cập nhật cấu hình — các mục đăng ký đã lưu đang có hiệu lực',
        fix: '',
      })
    }
  } catch (err) {
    checks.push({
      id: 'restart',
      label: 'Cần khởi động lại gateway?',
      status: 'unknown',
      detail: `Không thể xác định: ${(err as Error).message.slice(0, 200)}`,
      fix: '',
    })
  }

  // 9. Origin boleh menulis.
  const v = originVerdict(opts.host, opts.origin, process.env.ALLOWED_ORIGINS || '')
  checks.push({ id: 'origin', label: 'Origin được phép ghi', status: v.status, detail: v.detail, fix: v.fix })

  // 10. SELFREPAIR-1 + A2A-CALL-1: kemampuan MEMANGGIL per profil yang di-serve.
  // "Di-serve" = bisa DIPANGGIL; toolset a2a = bisa MEMANGGIL. Dipanggil ya +
  // memanggil tidak = keadaan rusak yang terlihat (rapat hanya jalan satu arah).
  // canCall dipakai — logika yang SAMA dengan sapu SELFREPAIR-1.
  if (!profiles) {
    checks.push({
      id: 'caller',
      label: 'Tác tử có thể gọi tác tử khác (toolset a2a)',
      status: 'unknown',
      detail: 'Không thể xác định — không đọc được danh sách hồ sơ',
      fix: '',
    })
  } else {
    try {
      const { profileToolsets } = await import('./kanban')
      const served = await listServedAgents().catch(() => null)
      if (served === null) {
        checks.push({
          id: 'caller',
          label: 'Tác tử có thể gọi tác tử khác (toolset a2a)',
          status: 'unknown',
          detail: 'Không thể xác định — không đọc được danh sách đăng ký phục vụ',
          fix: '',
        })
      } else {
        const rows = await Promise.all(
          served.map(async (s) => ({ s, tools: await profileToolsets(s.profile).catch(() => null) })),
        )
        const mute: string[] = []
        const unreadable: string[] = []
        for (const r of rows) {
          const c = canCall(r.tools)
          if (c === false) mute.push(r.s.profile)
          else if (c === null) unreadable.push(r.s.profile)
        }
        if (mute.length) {
          checks.push({
            id: 'caller',
            label: 'Tác tử có thể gọi tác tử khác (toolset a2a)',
            status: 'fail',
            detail: 'Có thể nhận cuộc gọi nhưng không gọi được: ' + mute.join(', ') + ' — có thể liên hệ các tác tử này nhưng chúng không thể gọi tác tử khác',
            fix: 'Thêm toolset a2a cho từng hồ sơ đó (gộp, không ghi đè) — gọi POST /api/hermes/selfrepair (xem docs/API-SPEC.md § selfrepair; tự quét, chạy lặp không đổi kết quả)',
          })
        } else if (unreadable.length) {
          checks.push({
            id: 'caller',
            label: 'Tác tử có thể gọi tác tử khác (toolset a2a)',
            status: 'unknown',
            detail: `Không thể xác định — không đọc được toolset của: ${unreadable.join(', ')}`,
            fix: '',
          })
        } else if (!rows.length) {
          checks.push({
            id: 'caller',
            label: 'Tác tử có thể gọi tác tử khác (toolset a2a)',
            status: 'unknown',
            detail: 'Không thể xác định — chưa có tác tử đăng ký phục vụ để đánh giá',
            fix: '',
          })
        } else {
          checks.push({
            id: 'caller',
            label: 'Tác tử có thể gọi tác tử khác (toolset a2a)',
            status: 'pass',
            detail: `Toàn bộ ${rows.length} tác tử đăng ký phục vụ có toolset a2a (nhận và thực hiện cuộc gọi)`,
            fix: '',
          })
        }
      }
    } catch (err) {
      checks.push({
        id: 'caller',
        label: 'Tác tử có thể gọi tác tử khác (toolset a2a)',
        status: 'unknown',
        detail: `Không thể xác định: ${(err as Error).message.slice(0, 200)}`,
        fix: '',
      })
    }
  }

  // 10b. A2A-CALL-1 sebab-2: nama agent harus RESOLVABLE (`a2a_agents.<slug>-local`).
  // Tanpa peer, `a2a_call("nama")` = `unknown agent` — hop cuma kebetulan jalan
  // bila model jatuh ke URL penuh. Peer hilang = FAIL + jalan keluar.
  if (profiles) {
    try {
      const { listA2aPeers, peerEntryUrl, peerKeyFor, samePeerUrl } = await import('./kanban')
      const served = await listServedAgents().catch(() => null)
      if (served === null) {
        checks.push({
          id: 'peers',
          label: 'Phân giải được tên tác tử (peer a2a_agents)',
          status: 'unknown',
          detail: 'Không thể xác định — không đọc được danh sách đăng ký phục vụ',
          fix: '',
        })
      } else {
        const peers = await listA2aPeers().catch(() => null)
        if (peers === null) {
          checks.push({
            id: 'peers',
            label: 'Phân giải được tên tác tử (peer a2a_agents)',
            status: 'unknown',
            detail: 'Không thể xác định — không đọc được danh sách peer a2a_agents (không phải danh sách trống)',
            fix: '',
          })
        } else {
          const missing = served.filter((s) => {
            const got = peers[peerKeyFor(s.profile)]?.url ? String(peers[peerKeyFor(s.profile)].url) : ''
            return !got || !samePeerUrl(got, peerEntryUrl(s.profile))
          })
          // 10c. Peer PROFIL: gate tool Hermes baca scope profil — served tanpa
          // peer di profil served lain = tool a2a_call tak muncul di sesinya.
          const { listProfilePeers } = await import('./kanban')
          const profRows = await Promise.all(
            served.map(async (s) => ({ s, mine: await listProfilePeers(s.profile).catch(() => null) })),
          )
          const profUnreadable = profRows.filter((r) => r.mine === null).map((r) => r.s.profile)
          const profMissing: string[] = []
          for (const r of profRows) {
            if (r.mine === null) continue
            for (const t of served) {
              if (t.profile.toLowerCase() === r.s.profile.toLowerCase()) continue
              const got = r.mine[peerKeyFor(t.profile)]?.url ? String(r.mine[peerKeyFor(t.profile)].url) : ''
              if (!got || !samePeerUrl(got, peerEntryUrl(t.profile))) {
                profMissing.push(`${r.s.profile}→${t.profile}`)
              }
            }
          }
          if (missing.length) {
            checks.push({
              id: 'peers',
              label: 'Phân giải được tên tác tử (peer a2a_agents)',
              status: 'fail',
              detail: `Thiếu peer: ${missing.map((s) => `${peerKeyFor(s.profile)} → ${peerEntryUrl(s.profile)}`).join(', ')} — a2a_call("nama") trả về unknown agent`,
              fix: 'Gọi POST /api/hermes/selfrepair — đăng ký peer còn thiếu, chạy lặp không đổi kết quả (xem docs/API-SPEC.md § selfrepair)',
            })
          } else if (profUnreadable.length) {
            checks.push({
              id: 'peers',
              label: 'Phân giải được tên tác tử (peer a2a_agents)',
              status: 'unknown',
              detail: `Không thể xác định — không đọc được peer trong hồ sơ: ${profUnreadable.join(', ')}`,
              fix: '',
            })
          } else if (profMissing.length) {
            checks.push({
              id: 'peers',
              label: 'Phân giải được tên tác tử (peer a2a_agents)',
              status: 'fail',
              detail: `Thiếu peer trong hồ sơ: ${profMissing.join(', ')} — công cụ a2a_call không xuất hiện trong phiên của hồ sơ đó (giới hạn phạm vi hồ sơ)`,
              fix: 'Gọi POST /api/hermes/selfrepair — ghi peer còn thiếu vào hồ sơ, chạy lặp không đổi kết quả (xem docs/API-SPEC.md § selfrepair)',
            })
          } else if (!served.length) {
            checks.push({
              id: 'peers',
              label: 'Phân giải được tên tác tử (peer a2a_agents)',
              status: 'unknown',
              detail: 'Không thể xác định — chưa có tác tử đăng ký phục vụ để đánh giá',
              fix: '',
            })
          } else {
            checks.push({
              id: 'peers',
              label: 'Phân giải được tên tác tử (peer a2a_agents)',
              status: 'pass',
              detail: `Toàn bộ ${served.length} tác tử đăng ký phục vụ có peer (${served.map((s) => peerKeyFor(s.profile)).join(', ')})`,
              fix: '',
            })
          }
        }
      }
    } catch (err) {
      checks.push({
        id: 'peers',
        label: 'Phân giải được tên tác tử (peer a2a_agents)',
        status: 'unknown',
        detail: `Không thể xác định: ${(err as Error).message.slice(0, 200)}`,
        fix: '',
      })
    }
  }
  // 11. SELFREPAIR-1 / HVO-03: passive only.
  // The old doctor POSTed a message-send "ping" to an unknown path to detect a
  // gateway fall-through bug. That can create a real agent turn/token spend and
  // probe the wrong local port. Default diagnostics must have NO model side
  // effects, so this check is deliberately UNKNOWN: without an active probe we
  // cannot prove the gateway rejects unknown paths. No probe feature is offered
  // in this patch.
  if (!a2aEnabled) {
    checks.push({
      id: 'fallthrough',
      label: 'A2A từ chối đường dẫn không xác định',
      status: 'unknown',
      detail: 'Không thể xác định — chưa xác minh nền tảng A2A đang bật; thăm dò chủ động đã tắt',
      fix: '',
    })
  } else {
    checks.push({
      id: 'fallthrough',
      label: 'A2A từ chối đường dẫn không xác định',
      status: 'unknown',
      detail:
        'Không thể xác định nếu không thăm dò chủ động — GET doctor KHÔNG gửi tin nhắn/POST đến gateway, ' +
        'nên không tác động đến mô hình/token. Hãy tự xác minh bằng curl nếu cần.',
      fix: '',
    })
  }

  void taskCount
  return { readAt: new Date().toISOString(), hermesBin: HERMES_BIN, checks }
}
