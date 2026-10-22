import { NextRequest, NextResponse } from 'next/server'
import { assertApiRequest } from '@/lib/api-policy'
import { previewRepairs, runRepairs } from '@/lib/hermes/selfrepair'

export const dynamic = 'force-dynamic'

/**
 * SELFREPAIR-1 Celah 2 — aplikasi memperbaiki keadaan rusaknya sendiri.
 *
 * GET = pratinjau saja: apa yang akan diubah + apa yang tak bisa diperbaiki.
 *       Read-only, tanpa guard tulis (sama seperti route doctor).
 * POST = jalankan perbaikan (pakai penulis yang sudah ada, backup sebelum
 *        menulis), lalu periksa ulang doctor-nya dan kembalikan keduanya —
 *        BUKAN klaim "beres". Guard tulis wajib (mengubah config + DB).
 * Keduanya idempoten: keadaan sehat → tak ada yang berubah.
 */
export async function GET(req: Request) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  try {
    const preview = await previewRepairs()
    return NextResponse.json({ success: true, ...preview })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'selfrepair_failed', message: (err as Error).message, status: 503 } },
      { status: 503 },
    )
  }
}

export async function POST(req: NextRequest) {
  const denied = assertApiRequest(req, 'privileged')
  if (denied) return denied
  try {
    const result = await runRepairs()
    // HVO-03: no doctor-after here. The old code re-ran diagnostics after
    // repair, which used to include an active A2A message/send probe. Diagnostics
    // are passive now, but the repair response still does not trigger side
    // effects; call GET /api/hermes/doctor yourself if you want a fresh read.
    return NextResponse.json({
      success: true,
      result,
      doctorSkipped: 'Không tự chạy doctor sau sửa chữa; GET /api/hermes/doctor chỉ đọc trạng thái',
    })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'selfrepair_failed', message: (err as Error).message, status: 502 } },
      { status: 502 },
    )
  }
}
