import { NextRequest, NextResponse } from 'next/server'
import { EVIDENCE_BATCH_CAP } from '@/lib/hermes/evidence'
import { evidenceMarks } from '@/lib/hermes/kanban'
import { assertApiRequest } from '@/lib/api-policy'

export const dynamic = 'force-dynamic'

/**
 * Penanda bukti untuk banyak task sekaligus (papan Kanban). POST hanya karena daftar id ada di
 * body — ini bacaan, tidak mengubah apa pun.
 *
 * RINGKAS: hanya `kanban show --json` per id (ringkasan + runs), tanpa log dan lampiran.
 * Maksimal EVIDENCE_BATCH_CAP id diperiksa; sisanya `unchecked` (netral, tidak dinilai).
 */
export async function POST(req: NextRequest) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const ids: unknown = body?.ids
  if (!Array.isArray(ids)) {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'Bắt buộc có ids (mảng)', status: 400 } },
      { status: 400 },
    )
  }
  try {
    const marks = await evidenceMarks(ids.filter((x): x is string => typeof x === 'string'))
    return NextResponse.json({
      mode: 'ringkas',
      note: 'Rút gọn: chỉ show+runs theo từng ID, không có nhật ký và tệp đính kèm; bảng chi tiết đọc toàn bộ dữ liệu',
      cap: EVIDENCE_BATCH_CAP,
      ageSeconds: 0,
      readAt: new Date().toISOString(),
      marks,
    })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'evidence_failed', message: (err as Error).message, status: 502 } },
      { status: 502 },
    )
  }
}
