import { NextRequest, NextResponse } from 'next/server'
import { assertApiRequest } from '@/lib/api-policy'
import {
  ACTION_EFFECT,
  agentPermissionSummary,
  checkAction,
  estopPath,
  readPause,
  type ActionKind,
  type ActionRequest,
} from '@/lib/hermes/control'
import { advanceTask, pauseAll, resumeAll, steerTask } from '@/lib/hermes/kanban'
import { applyFallback, planFallback } from '@/lib/hermes/fallback'
import { readProviders } from '@/lib/hermes/providers'
import { beginAudit, denyAudit, readAudit } from '@/lib/hermes/audit'

export const dynamic = 'force-dynamic'

/**
 * KENDALI — satu-satunya endpoint di office ini yang mengubah keadaan.
 *
 * GET  /api/hermes/control   — apakah sedang dijeda, dan apa arti tiap aksi
 * POST /api/hermes/control   — jalankan SATU aksi
 *
 * ATURAN YANG DIPEGANG DI SINI:
 *
 *   1. Daftar aksinya TERTUTUP. `checkAction` menolak apa pun di luar itu, jadi tidak ada
 *      string bebas yang bisa sampai ke CLI.
 *
 *   2. Aturan izinnya (`checkAction`) adalah fungsi murni di `control.ts`, dan dievaluasi
 *      SEBELUM apa pun dijalankan. Berkas ini tidak boleh punya aturannya sendiri — kalau
 *      punya, cepat atau lambat dua tempat itu berbeda pendapat soal aksi mana yang boleh.
 *
 *   3. Balasannya menyebut APA YANG TERJADI, bukan cuma "ok". Aksi yang tidak bisa dilaporkan
 *      hasilnya akan ditekan lagi oleh operator.
 */
export async function GET(req: NextRequest) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  try {
    return NextResponse.json({
      pause: readPause(),
      estopPath: estopPath(),
      actions: ACTION_EFFECT,
      audit: readAudit(30),
      /** Batas izin per role agent (TAHAP 5.4), dari tabel tunggal di control.ts. */
      agentPermissions: agentPermissionSummary(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'control_failed', message: (err as Error).message, status: 503 } },
      { status: 503 },
    )
  }
}

const KINDS: ActionKind[] = ['pauseAll', 'resumeAll', 'unblock', 'promote', 'release', 'setFallback']

export async function POST(req: NextRequest) {
  // Control can pause the whole install, release workers or replace the fallback
  // chain; the whole endpoint is privileged (management write + explicit
  // HVO_ALLOW_PRIVILEGED=1).
  const guard = assertApiRequest(req, 'privileged')
  if (guard) return guard

  let body: ActionRequest & { steer?: string }
  try {
    body = (await req.json()) as ActionRequest & { steer?: string }
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'body không phải JSON', status: 400 } },
      { status: 400 },
    )
  }

  if (!KINDS.includes(body.action)) {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: `Thao tác "${body.action}" không xác định`, status: 400 } },
      { status: 400 },
    )
  }

  const verdict = checkAction(body)
  if (!verdict.allowed) {
    // Penolakan juga dicatat: tanpa ini, "ditolak diam-diam" tidak bisa dibedakan dari
    // "tidak pernah diminta".
    denyAudit(
      {
        at: new Date().toISOString(),
        action: body.steer ? 'steer' : body.action,
        taskId: body.taskId,
        reason: (body.reason || '').slice(0, 300),
        effect: ACTION_EFFECT[body.action]?.effect || '',
      },
      verdict.why,
    )
    return NextResponse.json(
      { error: { code: 'refused', message: verdict.why, status: 400 } },
      { status: 400 },
    )
  }

  // Dicatat SEBELUM aksinya berjalan. Aksi yang menghentikan sistem bisa ikut mematikan
  // proses ini, dan catatan yang ditulis belakangan akan hilang justru pada kasus yang
  // paling perlu dicatat.
  const audit = beginAudit({
    at: new Date().toISOString(),
    action: body.steer ? 'steer' : body.action,
    taskId: body.taskId,
    reason: (body.reason || '').slice(0, 300),
    effect: body.steer
      ? 'Gửi chỉ dẫn cho worker đang chạy'
      : ACTION_EFFECT[body.action]?.effect || '',
  })

  try {
    // Arahkan (steer) bukan salah satu `ActionKind`: ia tidak mengubah status, cuma mengirim
    // teks. Ditangani terpisah supaya tidak ikut masuk daftar aksi yang mengubah keadaan.
    if (body.steer) {
      if (!body.taskId) {
        return NextResponse.json(
          { error: { code: 'invalid_request', message: 'steer cần ID công việc', status: 400 } },
          { status: 400 },
        )
      }
      await steerTask(body.taskId, body.steer)
      audit.finish(`Đã gửi chỉ dẫn đến ${body.taskId}`, true)
      return NextResponse.json({ ok: true, did: `Đã gửi chỉ dẫn đến ${body.taskId}`, pause: readPause() })
    }

    let did: string
    switch (body.action) {
      case 'pauseAll':
        await pauseAll((body.reason || '').trim())
        did = 'Đã tạm dừng toàn bộ công việc mới'
        break
      case 'resumeAll':
        await resumeAll()
        did = 'Đã tiếp tục điều phối công việc'
        break
      case 'unblock':
        await advanceTask('unblock', body.taskId!, body.reason)
        did = `${body.taskId} đã được bỏ chặn`
        break
      case 'promote':
        await advanceTask('promote', body.taskId!, body.reason)
        did = `${body.taskId} đã được chuyển sang ready`
        break
      case 'release':
        await advanceTask('release', body.taskId!)
        did = `worker của ${body.taskId} đã được giải phóng`
        break
      case 'setFallback': {
        // Cadangan chain dihitung ULANG di sini dari data yang diukur, bukan diterima dari
        // klien. Body request tidak boleh menentukan provider mana yang dipasang — kalau bisa,
        // halaman yang salah render bisa mengarahkan seluruh kerja ke provider sembarangan.
        const plan = planFallback(readProviders(6).providers)
        if (plan.kind !== 'propose') {
          return NextResponse.json(
            {
              error: {
                code: 'no_candidate',
                message:
                  plan.kind === 'empty'
                    ? 'Chuỗi dự phòng đã được thiết lập'
                    : `Không có ứng viên phù hợp: ${plan.why}`,
                status: 400,
              },
            },
            { status: 400 },
          )
        }
        const { backup } = applyFallback(plan.proposed)
        did = `Đã thiết lập dự phòng: ${plan.proposed.map((e) => `${e.model} (${e.provider})`).join(', ')} — tệp sao lưu tại ${backup}`
        break
      }
      default:
        return NextResponse.json(
          { error: { code: 'invalid_request', message: `Thao tác "${body.action}" chưa được xử lý`, status: 400 } },
          { status: 400 },
        )
    }
    // Keadaan pause dibaca ULANG dari sentinel setelah aksi, jadi UI tidak perlu menebak
    // apakah aksinya berhasil — yang dilaporkan adalah kenyataannya.
    audit.finish(did, true)
    return NextResponse.json({ ok: true, did, pause: readPause() })
  } catch (err) {
    audit.finish(`THẤT BẠI: ${(err as Error).message}`, false)
    return NextResponse.json(
      { error: { code: 'action_failed', message: (err as Error).message, status: 502 } },
      { status: 502 },
    )
  }
}
