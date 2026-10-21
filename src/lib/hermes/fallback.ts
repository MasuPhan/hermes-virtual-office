/**
 * CADANGAN PROVIDER — menyiapkan, TIDAK menyalakan.
 *
 * MASALAHNYA NYATA: chain cadangan kosong (`hermes fallback list` -> "No fallback providers
 * configured"), dan satu-satunya provider terdaftar adalah 9router — yang sedang balas 520
 * berulang. Jadi ketika 9router gagal, tidak ada yang menggantikannya, dan kerja yang sedang
 * jalan cuma mati.
 *
 * KENAPA BERKAS INI HANYA MENYIAPKAN. Mengubah chain cadangan berarti mengubah provider yang
 * dipakai agent yang sedang bekerja — seluruh instalasi. Itu keputusan pemilik, bukan efek
 * samping dari sebuah tombol di kantor 3D. Jadi di sini ada:
 *
 *   - `planFallback()`  menghitung APA yang sebaiknya ditulis, dan dari mana angkanya
 *   - `applyFallback()` menulisnya, TAPI hanya dipanggil manusia lewat endpoint kendali
 *
 * dan tidak ada satu pun jalur otomatis di antaranya.
 *
 * SAMPEL KECIL TIDAK BOLEH JADI DASAR. Kandidat diambil dari `providers.ts`, yang menandai
 * `confident: false` untuk provider dengan < 10 panggilan. Provider yang belum pernah gagal
 * KARENA BELUM PERNAH DIPAKAI bukan provider yang baik — dan menyarankannya justru berbahaya:
 * kegagalannya baru ketahuan saat dibutuhkan.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderStat } from './providers'
import { MIN_SAMPLES } from './providers'
import { resolveFleetRoot } from './root'

/** Resolved per call, so tests and an explicit HVO_HERMES_ROOT agree. */
function configPath(): string {
  return join(resolveFleetRoot(process.env), 'config.yaml')
}

export type FallbackEntry = { provider: string; model: string }

export type FallbackPlan =
  /** Apa yang sekarang tertulis di config. */
  | { kind: 'empty'; current: FallbackEntry[] }
  /** Ada usulan, dan usulan itu punya alasan yang bisa dibaca. */
  | { kind: 'propose'; current: FallbackEntry[]; proposed: FallbackEntry[]; why: string }
  /** Tidak ada usulan, dan ini alasannya — bukan diam-diam tidak melakukan apa pun. */
  | { kind: 'none'; current: FallbackEntry[]; why: string }

/**
 * Chain cadangan yang sekarang, dibaca dari config.yaml.
 *
 * Dibaca sebagai TEKS, bukan di-parse sebagai YAML: berkas ini ditulis Hermes dan berisi
 * komentar serta struktur bersarang yang tidak boleh hilang kalau ditulis ulang oleh parser
 * yang belum paham seluruh isinya. Untuk MEMBACA satu daftar, regex sudah cukup dan tidak
 * berisiko merusak apa pun.
 */
export function readFallback(): FallbackEntry[] {
  const CONFIG = configPath()
  if (!existsSync(CONFIG)) return []
  try {
    const text = readFileSync(CONFIG, 'utf8')
    const lines = text.split('\n')
    const start = lines.findIndex((l) => /^fallback_providers\s*:/.test(l))
    if (start < 0) return []
    const out: FallbackEntry[] = []
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]
      // Item daftar YAML: diawali "-" pada indentasi lebih dalam dari kuncinya.
      if (/^\S/.test(l)) break
      const pm = /provider\s*:\s*["']?([^\s"']+)/.exec(l)
      const mm = /model\s*:\s*["']?([^\s"']+)/.exec(l)
      if (pm && mm) out.push({ provider: pm[1], model: mm[1] })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Usulkan chain cadangan, dari data yang sudah diukur.
 *
 * Aturannya, dan tiap satunya punya alasan:
 *
 *   1. Kandidat harus `confident` — sampelnya cukup. Belum pernah gagal karena belum pernah
 *      dipakai BUKAN bukti kestabilan.
 *   2. Provider yang sedang gagal TIDAK diusulkan jadi cadangan untuk dirinya sendiri.
 *   3. Model cadangan diambil dari model yang BENAR-BENAR pernah dipakai lewat provider itu,
 *      bukan dikarang — model yang tidak ada hanya akan gagal saat dibutuhkan.
 */
export function planFallback(providers: ProviderStat[], primary = 'custom:9router'): FallbackPlan {
  const current = readFallback()
  if (current.length > 0) return { kind: 'empty', current }

  // PEMBANDINGNYA ADALAH PROVIDER UTAMA, bukan angka nol.
  //
  // Versi pertama berkas ini menyaratkan `failures === 0`, dan itu MENYESATKAN: pada data
  // nyata, tidak ada provider dengan nol gagal sama sekali, jadi tidak ada usulan apa pun —
  // padahal ada provider yang jelas LEBIH BAIK dari yang sedang dipakai. Syarat yang benar
  // adalah "lebih jarang gagal daripada yang sekarang", diukur dari sampel yang cukup.
  const primaryStat = providers.find((p) => normalize(p.provider) === normalize(primary))
  const floor = primaryStat ? primaryStat.failureRate : 0

  const healthy = providers.filter(
    (p) =>
      p.confident &&
      p.models.length > 0 &&
      normalize(p.provider) !== normalize(primary) &&
      p.failureRate < floor,
  )

  if (healthy.length === 0) {
    // Yang BELUM TERTENTU di sini tidak boleh disamarkan jadi "tidak ada masalah".
    const almost = providers.filter((p) => p.failures === 0 && p.calls > 0 && p.calls < MIN_SAMPLES)
    const why =
      almost.length > 0
        ? `Chưa có nhà cung cấp đủ mẫu (tối thiểu ${MIN_SAMPLES} lần gọi). Gần đạt: ${almost
            .map((p) => `${p.provider} (${p.calls})`)
            .join(', ')}`
        : 'Chưa từng sử dụng nhà cung cấp nào khác — không thể lập dự phòng khi không có dữ liệu'
    return { kind: 'none', current, why }
  }

  const best = healthy[0]
  return {
    kind: 'propose',
    current,
    proposed: [{ provider: normalize(best.provider), model: best.models[0] }],
    why: `${best.provider}: ${best.calls} lần gọi, ${best.failures} thất bại (${(best.failureRate * 100).toFixed(1)}%) — tỷ lệ lỗi thấp hơn ${primary}${primaryStat ? ` (${(primaryStat.failureRate * 100).toFixed(1)}%)` : ''}. Mô hình lấy từ các mô hình thực sự đã dùng qua nhà cung cấp đó.`,
  }
}

/**
 * `custom:9router` -> `9router`. Hermes menulis provider cadangan sebagai nama pendek, dan
 * `custom:` yang ikut tertulis akan membuat resolver-nya gagal menemukan providernya.
 */
function normalize(p: string): string {
  return p.startsWith('custom:') ? p.slice('custom:'.length) : p
}

/**
 * Tulis chain cadangan. HANYA dipanggil dari endpoint kendali, atas permintaan manusia.
 *
 * Ada cadangan berkas sebelum menulis: berkas yang salah tulis berarti seluruh instalasi
 * kehilangan konfigurasinya, dan itu bukan harga yang pantas untuk sebuah tombol.
 */
/**
 * Create a backup with explicit 0600 and exclusive create (`wx`).
 *
 * HVO-13: a plain `writeFileSync` inherits the process umask, so under umask 022
 * a full config backup could be world-readable even when the source was 0600.
 * `wx` also refuses to overwrite an existing file, so two writers cannot race
 * onto the same backup path.
 */
export function createSecureBackup(configFile: string, content: string): string {
  const backup = `${configFile}.bak-sebelum-fallback-${Date.now()}-${process.pid}`
  let fd: number | null = null
  try {
    fd = openSync(backup, 'wx', 0o600)
    writeFileSync(fd, content, 'utf8')
    return backup
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already closed */ }
      try { unlinkSync(backup) } catch { /* not created */ }
    }
    throw new Error(`Không thể tạo bản sao lưu cấu hình an toàn: ${(err as Error).message}`)
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
}

export function applyFallback(entries: FallbackEntry[]): { backup: string } {
  const CONFIG = configPath()
  if (!existsSync(CONFIG)) throw new Error(`Không tìm thấy config.yaml tại ${CONFIG}`)
  const original = readFileSync(CONFIG, 'utf8')
  const backup = createSecureBackup(CONFIG, original)

  const lines = original.split('\n')
  const start = lines.findIndex((l) => /^fallback_providers\s*:/.test(l))
  const block = ['fallback_providers:', ...entries.map((e) => `  - provider: ${e.provider}\n    model: ${e.model}`)]

  if (start < 0) {
    // Belum ada kuncinya: tambahkan di akhir, jangan menyisipkan di tengah struktur bersarang.
    writeFileSync(CONFIG, `${original.trimEnd()}\n\n${block.join('\n')}\n`, 'utf8')
    return { backup }
  }

  // Ganti blok lamanya utuh: dari baris kunci sampai item terakhir daftarnya.
  let end = start + 1
  while (end < lines.length && !/^\S/.test(lines[end])) end++
  const next = [...lines.slice(0, start), ...block, ...lines.slice(end)]
  writeFileSync(CONFIG, next.join('\n'), 'utf8')
  return { backup }
}

/** Config path for diagnostics/tests; resolved from the explicit fleet root. */
export function configPathFor(): string {
  return configPath()
}

/** Dipakai tes: hapus berkas cadangan yang dibuat `applyFallback`. */
export function dropBackup(path: string): void {
  if (existsSync(path)) unlinkSync(path)
}
