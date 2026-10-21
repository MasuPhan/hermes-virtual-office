import { NextRequest, NextResponse } from 'next/server'
import { assertApiRequest } from '@/lib/api-policy'
import { actOnJob, createJob, listJobs, listRuns, parseLimit, readJobList, type JobAction } from '@/lib/hermes/cron'
import { cronPulse } from '@/lib/office/duty'

export const dynamic = 'force-dynamic'

/**
 * Cron job management.
 *
 * GET  /api/hermes/cron            — every job + its recent runs
 * GET  /api/hermes/cron?id=<job>   — one job + its runs
 * POST /api/hermes/cron            — create a job, or act on one
 *
 * The UI asks for a second click before an action runs, but that is a UI
 * courtesy: this endpoint executes what it is told, because it cannot tell a
 * confirmed click from an unconfirmed one. Documented in API-SPEC.md.
 */
export async function GET(req: NextRequest) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  const id = req.nextUrl.searchParams.get('id')
  const limit = Number(req.nextUrl.searchParams.get('limit') || 25)
  try {
    // `?pulse=1` — cron agent yang baru jalan, untuk kantor. Hanya membaca jobs.json (tanpa
    // `cron runs` lewat CLI), karena dipoll tiap beberapa detik. Hasilnya TIDAK menyebut agent:
    // cron tidak punya pemilik di Hermes (lihat `cronPulse`).
    if (req.nextUrl.searchParams.get('pulse') === '1') {
      return NextResponse.json({ pulse: cronPulse((await readJobList()).jobs, Date.now()) })
    }
    if (id) {
      const readout = await readJobList()
      if (readout.failure) {
        return NextResponse.json(
          { error: { code: 'cron_unreadable', message: readout.failure, status: 502 } },
          { status: 502 },
        )
      }
      const job = readout.jobs.find((j) => j.id === id)
      if (!job) {
        return NextResponse.json(
          { error: { code: 'invalid_request', message: `Tác vụ "${id}" không tìm thấy`, status: 404 } },
          { status: 404 },
        )
      }
      return NextResponse.json({ job, runs: await listRuns(id, limit) })
    }
    const readout = await readJobList()
    return NextResponse.json({
      jobs: readout.jobs,
      runs: await listRuns(undefined, limit),
      // Diikuti pola `failure` di observability/approvals: bacanya yang gagal
      // harus terlihat GAGAL — panel wajib menampilkannya, bukan "tidak ada job".
      ...(readout.failure
        ? { jobsFailure: readout.failure, jobsAgeSeconds: readout.ageSeconds }
        : { jobsAgeSeconds: readout.ageSeconds }),
    })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'hermes_unavailable', message: (err as Error).message, status: 503 } },
      { status: 503 },
    )
  }
}

const ACTIONS: JobAction[] = ['pause', 'resume', 'run', 'remove']

export async function POST(req: NextRequest) {
  const ingress = assertApiRequest(req, 'management-write')
  if (ingress) return ingress
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action || '')
  // `run` executes work now; `remove` deletes a job. Both are destructive in
  // their own way and need the second explicit opt-in.
  const policyDenied = assertApiRequest(
    req,
    action === 'run' || action === 'remove' ? 'privileged' : 'management-write',
  )
  if (policyDenied) return policyDenied

  try {
    /* ------------------------------------------------------------- create --- */
    if (action === 'create') {
      const schedule = String(body?.schedule || '')
      const prompt = body?.prompt ? String(body.prompt) : ''
      const script = body?.script ? String(body.script) : ''
      if (!schedule.trim()) {
        return NextResponse.json(
          { error: { code: 'invalid_request', message: 'Bắt buộc nhập lịch chạy', status: 400 } },
          { status: 400 },
        )
      }
      if (!prompt.trim() && !script.trim()) {
        return NextResponse.json(
          { error: { code: 'invalid_request', message: 'Nhập prompt hoặc script', status: 400 } },
          { status: 400 },
        )
      }
      const id = await createJob({
        schedule,
        prompt,
        script,
        name: body?.name ? String(body.name) : undefined,
        // Default to paused: a job created live can fire before anyone has read
        // it, and the UI offers "langsung aktif" explicitly for when that is wanted.
        paused: body?.paused !== false,
        deliver: body?.deliver ? String(body.deliver) : undefined,
        noAgent: Boolean(body?.noAgent),
        repeat: Number.isFinite(Number(body?.repeat)) ? Number(body.repeat) : undefined,
      })
      const job = (await listJobs()).find((j) => j.id === id) ?? null
      return NextResponse.json({ success: true, action, id, job }, { status: 201 })
    }

    /* --------------------------------------------------------------- act --- */
    if (!ACTIONS.includes(action as JobAction)) {
      return NextResponse.json(
        {
          error: {
            code: 'invalid_request',
            message: `action phải là một trong: create, ${ACTIONS.join(', ')}`,
            status: 400,
          },
        },
        { status: 400 },
      )
    }

    const id = String(body?.id || '').trim()
    if (!id) {
      return NextResponse.json(
        { error: { code: 'invalid_request', message: 'Bắt buộc nhập ID tác vụ', status: 400 } },
        { status: 400 },
      )
    }
    await actOnJob(id, action as JobAction)
    return NextResponse.json({
      success: true,
      action,
      id,
      // `remove` has nothing left to read back.
      job: action === 'remove' ? null : ((await listJobs()).find((j) => j.id === id) ?? null),
    })
  } catch (err) {
    const msg = (err as Error).message
    // "tidak ditemukan" and the validation messages are the caller's fault.
    const isUserError = /tidak ditemukan|wajib diisi|tidak valid|isi prompt atau script/.test(msg)
    return NextResponse.json(
      {
        error: {
          code: isUserError ? 'invalid_request' : 'action_failed',
          message: msg,
          status: isUserError ? 400 : 502,
        },
      },
      { status: isUserError ? 400 : 502 },
    )
  }
}
