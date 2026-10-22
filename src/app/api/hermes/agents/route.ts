import { NextRequest, NextResponse } from 'next/server'
import {
  createProfile,
  deleteProfile,
  hermesHome,
  listAgents,
  listAssignees,
  listProfiles,
  listTasks,
  profileModel,
  purgeTasks,
  setProfileModel,
  tasksForAssignee,
  activeTasksAllBoards,
} from '@/lib/hermes/kanban'
import { BUILTIN_HIDDEN, hiddenNames, isHidden, hide, show } from '@/lib/hermes/office-membership'
import { assertApiRequest } from '@/lib/api-policy'
import type { AgentDivision, AgentRole } from '@/types/hermes'
import { ROLE_LABEL, soulFor } from '@/lib/hermes/soul'
import { parseDomains, ownersForDomains } from '@/lib/hermes/a2a'
import {
  A2A_CONFIG_WRITE_DISABLED_REASON,
  listServedAgents,
  removeServedAgent,
  upsertServedAgent,
} from '@/lib/hermes/a2a-served'
import { gatewayStartMs, needsRestart } from '@/lib/hermes/doctor'
import { stat } from 'node:fs/promises'
import { deleteAvatar } from '@/lib/office/db'
import { blockedAssigneesFor } from '@/lib/hermes/approvals'
import { agentPermissionSummary, checkAgentAction, type AgentActionKind } from '@/lib/hermes/control'
import { denyAudit } from '@/lib/hermes/audit'
import { validateProfileName } from '@/lib/hermes/profile-name'

export const dynamic = 'force-dynamic'

/**
 * SATU SUMBER KEBENARAN "butuh restart": mtime config.yaml vs start gateway —
 * pembanding yang SAMA dipakai doctor (SETUP-1), pop up, dan checklist A2A
 * Ready. null = tak bisa dipastikan (bukan "tidak butuh").
 */
async function readNeedsGatewayRestart(): Promise<boolean | null> {
  try {
    const mtime = (await stat(`${hermesHome()}/config.yaml`)).mtimeMs
    return needsRestart(mtime, await gatewayStartMs())
  } catch {
    return null
  }
}

/**
 * The spawn/hide/kill menu.
 *
 * `available` is every Hermes profile; `inOffice` is the subset currently shown
 * in the 3D room. `hide` and `spawn` toggle office membership only — they never
 * touch the profile or its tasks. `kill` is the destructive one: it deletes the
 * profile and purges its tasks.
 */
export async function GET(req: NextRequest) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  try {
    const [assignees, tasks, profiles] = await Promise.all([
      listAssignees(),
      listTasks({ includeArchived: true }),
      listProfiles(),
    ])
    // Pass the assignees already fetched: listAgents() would spawn the same CLI
    // read a second time.
    // Agent yang task aktifnya menunggu manusia tampil 'blocked', bukan 'working'.
    // Busy state from ALL boards, same as /api/hermes/tasks (avatars must agree).
    const busy = await activeTasksAllBoards(tasks, '')
    const blockedAgentIds = await blockedAssigneesFor(busy)
    const agents = await listAgents(busy, assignees, blockedAgentIds)
    const inOffice = new Set(agents.filter((a) => !isHidden(a.name)).map((a) => a.name))
    // Union of assignees and on-disk profiles: a profile with no tasks is still a
    // profile, and must be listed or creating one looks like it failed.
    const counts = new Map(assignees.map((a) => [a.name, a.total]))
    // Management includes hidden/outside profiles so office settings remain
    // reachable. inOffice still follows the existing membership policy.
    const roster = [...new Set([...counts.keys(), ...profiles])].sort()
    // Each profile's default model costs one CLI read (`-p <name> config get
    // model`), so they run in parallel and only for profiles that exist on disk —
    // an assignee left over from a deleted profile has no config to read.
    const models = await Promise.all(
      roster.map(async (name) =>
        profiles.includes(name) ? (await profileModel(name)).model : null,
      ),
    )
    // role/division/soul/domains dari listAgents (baca SOUL.md + fallback keyword).
    const agentMeta = new Map(agents.map((a) => [a.name, a]))
    const served = await listServedAgents().catch(() => [])
    const servedByProfile = new Map(served.map((s) => [s.profile, s]))
    // SATU SUMBER KEBENARAN "butuh restart" (lihat helper di atas): dipakai
    // pop up + checklist + panel Sistem, jangan hitung ulang di klien.
    let needsGatewayRestart: boolean | null = null
    needsGatewayRestart = await readNeedsGatewayRestart()
    // Peta domain→pemilik untuk jawaban jujur "siapa pegang X".
    const servedDesc = new Map(served.map((s) => [s.profile, s.description]))
    const domainAgents = agents.map((a) => ({
      name: a.name,
      domains: a.domains ?? [],
      description: servedDesc.get(a.name) ?? null,
    }))
    return NextResponse.json({
      available: roster.map((name, i) => ({
        name,
        total: counts.get(name) ?? 0,
        /** True when the profile exists on disk (not just as a task assignee). */
        profile: profiles.includes(name),
        inOffice: inOffice.has(name),
        /** The profile's default model, when it has one. */
        model: models[i],
        /** Role + divisi (dari SOUL.md, fallback keyword nama). */
        role: agentMeta.get(name)?.role ?? null,
        division: agentMeta.get(name)?.division ?? null,
        soulExists: agentMeta.get(name)?.soulExists ?? false,
        /** Keahlian/domain (dari marker SOUL.md; dipakai office, bukan A2A). */
        domains: agentMeta.get(name)?.domains ?? [],
        /**
         * Status A2A jujur: 'served' = terdaftar di platforms.a2a.agents,
         * 'unlisted' = profil ada tapi belum didaftarkan. Bukan "aktif" —
         * daftarnya baru berlaku setelah gateway di-restart.
         */
        a2a: servedByProfile.has(name) ? 'served' : profiles.includes(name) ? 'unlisted' : null,
        /** Why it is absent, when it is. */
        reason: inOffice.has(name)
          ? null
          : isHidden(name)
            ? 'hidden'
            : profiles.includes(name)
              ? 'unknown'
              : 'no_profile',
      })),
      hidden: hiddenNames(),
      /** Batas izin per role (TAHAP 5.4), dari tabel tunggal di control.ts. */
      permissions: agentPermissionSummary(),
      /**
       * Pemetaan domain→pemilik (dipakai office, bukan A2A). Domain tanpa
       * pemilik bernilai null — TAMPILKAN apa adanya, jangan mengarang.
       */
      domainOwners: ownersForDomains(
        [...new Set(domainAgents.flatMap((a) => a.domains))],
        domainAgents,
      ),
      /**
       * Butuh restart gateway? boolean | null — SATU sumber kebenaran yang
       * sama dengan doctor (mtime config vs start gateway). null = tak bisa
       * dipastikan (UI tampilkan abu, bukan hijau).
       */
      needsGatewayRestart,
    })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'hermes_unavailable', message: (err as Error).message, status: 503 } },
      { status: 503 },
    )
  }
}

/**
 * Spawn or kill a profile.
 *
 * `action: "spawn"` brings a profile into the office; it walks in through the
 * front door. `action: "kill"` removes it; the avatar walks out of the door and
 * despawns on arrival, rather than vanishing at its desk.
 */
export async function POST(req: NextRequest) {
  // Host + exact Origin first; the per-action access level (office-only vs
  // management vs privileged) is enforced below once `action` is known.
  const ingress = assertApiRequest(req, 'office-write')
  if (ingress) return ingress
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action || '')
  const name = String(body?.name || '').trim()

  if (
    action !== 'spawn' &&
    action !== 'hide' &&
    action !== 'kill' &&
    action !== 'create' &&
    action !== 'set-model' &&
    action !== 'serve' &&
    action !== 'unserve'
  ) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_request',
          message: "action phải là 'spawn', 'hide', 'kill', 'create', 'set-model', 'serve' hoặc 'unserve'",
          status: 400,
        },
      },
      { status: 400 },
    )
  }

  // HVO-11: validate at the API boundary BEFORE any CLI/filesystem work.
  // Names like `..`, `a/b`, empty or overlong strings never reach path.join or
  // the Hermes CLI. `default` is valid only for the membership actions.
  let cleanName: string
  try {
    cleanName = validateProfileName(name, {
      allowDefault: action === 'spawn' || action === 'hide',
    })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: (err as Error).message, status: 400 } },
      { status: 400 },
    )
  }

  // Destructive/installation-wide actions need the second explicit opt-in.
  const access =
    action === 'kill'
      ? 'privileged'
      : action === 'create' || action === 'set-model' || action === 'serve' || action === 'unserve'
        ? 'management-write'
        : 'office-write'
  const policyDenied = assertApiRequest(req, access)
  if (policyDenied) return policyDenied

  if (!cleanName) {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'Bắt buộc nhập name', status: 400 } },
      { status: 400 },
    )
  }

  // Atas nama agent (TAHAP 5.4): bila `onBehalfOf` ada, batas izin per role dinilai DULU dan
  // penolakannya dicatat di audit. Tanpa `onBehalfOf` (operator lewat UI), tidak ada yang
  // berubah. SELFREPAIR-1: serve/unserve operator-only (mengubah config gateway) —
  // permintaan atas nama agent DITOLAK eksplisit, bukan dipetakan ke izin lain.
  if (body?.onBehalfOf != null && (action === 'serve' || action === 'unserve')) {
    const ob = body.onBehalfOf as { agent?: unknown; role?: unknown }
    const agent = typeof ob?.agent === 'string' ? ob.agent.trim() : ''
    denyAudit(
      {
        at: new Date().toISOString(),
        action: `agent:${action}`,
        agent: agent || '(không tên)',
        reason: `${action} "${name}" thay mặt ${agent || '?'}`,
        effect: `Yêu cầu của tác tử để ${action} hồ sơ "${name}"`,
      },
      `Chỉ người vận hành mới được ${action === 'serve' ? 'đăng ký' : 'thu hồi'} mục A2A — tác tử không có quyền sửa cấu hình gateway`,
    )
    return NextResponse.json(
      {
        error: {
          code: 'refused',
          message: `Chỉ người vận hành mới được ${action === 'serve' ? 'đăng ký' : 'thu hồi'} mục A2A — tác tử không có quyền sửa cấu hình gateway`,
          status: 400,
        },
      },
      { status: 400 },
    )
  }
  if (body?.onBehalfOf != null) {
    const ob = body.onBehalfOf as { agent?: unknown; role?: unknown }
    const kind: AgentActionKind =
      action === 'kill' ? 'kill' : action === 'create' ? 'create' : action === 'set-model' ? 'setModel' : 'spawn'
    const agent = typeof ob?.agent === 'string' ? ob.agent.trim() : ''
    const role = (typeof ob?.role === 'string' ? ob.role.trim() : '') as AgentRole
    const verdict = checkAgentAction({ agent, role, action: kind, reason: body?.reason ? String(body.reason) : undefined })
    if (!verdict.allowed) {
      denyAudit(
        {
          at: new Date().toISOString(),
          action: `agent:${action}`,
          agent: agent || '(không tên)',
          reason: `${action} "${name}" thay mặt ${agent || '?'} (${role || '?'})`.slice(0, 300),
          effect: `Yêu cầu của tác tử để ${action} hồ sơ "${name}"`,
        },
        verdict.why,
      )
      return NextResponse.json(
        { error: { code: 'refused', message: verdict.why, status: 400 } },
        { status: 400 },
      )
    }
  }

  // A2A served-agent registration: DISABLED (HVO-01). Refuse serve/unserve here,
  // before any profile or gateway-config read/write. The writer itself also fails
  // closed; the gateway config must be edited manually until a correct YAML
  // serializer exists.
  if (action === 'serve' || action === 'unserve') {
    return NextResponse.json(
      {
        success: false,
        disabled: true,
        error: {
          code: 'a2a_config_write_disabled',
          message: A2A_CONFIG_WRITE_DISABLED_REASON,
          status: 501,
        },
      },
      { status: 501 },
    )
  }

  if (action === 'set-model') {
    const model = body?.model == null ? '' : String(body.model).trim()
    const provider = body?.provider == null ? null : String(body.provider).trim() || null
    if (!model) {
      return NextResponse.json(
        { error: { code: 'invalid_request', message: 'Bắt buộc chọn model', status: 400 } },
        { status: 400 },
      )
    }
    try {
      await setProfileModel(cleanName, model, provider)
      return NextResponse.json({ success: true, action, name: cleanName, model, provider })
    } catch (err) {
      return NextResponse.json(
        { error: { code: 'action_failed', message: (err as Error).message, status: 502 } },
        { status: 502 },
      )
    }
  }

  // Creating a profile is a different operation: it makes the profile, writes
  // its SOUL.md (1 prompt dari form, atau template per role), walks the
  // agent in, and returns a distinct shape so the UI can report what happened.
  if (action === 'create') {
    const role = (typeof body?.role === 'string' && body.role.trim() ? body.role.trim() : 'backend') as AgentRole
    const division = (
      typeof body?.division === 'string' && body.division.trim() ? body.division.trim() : undefined
    ) as AgentDivision | undefined
    const soul = typeof body?.soul === 'string' ? body.soul : ''
    // Keahlian/domain: freetext koma dari form → ternormalisasi di createProfile.
    // Disimpan di marker SOUL.md (dipakai office), TIDAK diumumkan ke A2A.
    const domains = Array.isArray(body?.domains)
      ? (body.domains as unknown[]).map((d) => String(d ?? '')).filter((d) => d.trim())
      : typeof body?.domains === 'string'
        ? [body.domains]
        : []
    // Toolset yang diumumkan di agent card: HARUS nama toolset nyata Hermes
    // (bukan tag bebas — card hanya bisa berisi itu). Kosong = semua toolset.
    const advertisedToolsets = Array.isArray(body?.advertisedToolsets)
      ? (body.advertisedToolsets as unknown[]).map((t) => String(t ?? '').trim()).filter(Boolean)
      : []
    // HVO-01: A2A registration is OPT-IN. Only an explicit `serveA2a: true`
    // attempts it; omission never touches gateway config. The writer itself is
    // disabled in this patch, so an explicit opt-in reports the deferred
    // capability honestly instead of mutating config or other profiles.
    const serveA2a = body?.serveA2a === true
    // Model pilihan operator saat membuat. Kosong = jangan sentuh config profil sama
    // sekali, supaya agent baru ikut bawaan Hermes, bukan dipaksa ke satu model.
    const model = body?.model == null ? '' : String(body.model).trim()
    const provider = body?.provider == null ? null : String(body.provider).trim() || null
    try {
      const created = await createProfile(name, {
        description: String(body?.description || ''),
        role,
        division,
        soul,
        domains,
      })
      // Diset SETELAH profil ada (createProfile yang gagal sudah lempar ke catch di bawah,
      // jadi tidak ada model yang tertulis untuk profil yang tidak jadi). Kalau langkah ini
      // gagal, profilnya tetap sudah ada — membatalkan create demi model justru membuang
      // kerja operator. Maka balasannya tetap 201, tapi jujur: model tidak terpasang dan
      // agent berjalan dengan bawaan Hermes sampai di-set ulang dari panel Agent.
      let modelApplied: string | null = null
      let providerApplied: string | null = null
      let modelError: string | null = null
      if (model) {
        try {
          await setProfileModel(created.name, model, provider)
          modelApplied = model
          providerApplied = provider
        } catch (err) {
          modelError = (err as Error).message
        }
      }
      // A brand-new profile carries no kill-list entry, so it appears on the next
      // poll — no need to touch membership.
      // Toggle A2A hidup: daftarkan served-agent (backup config dulu). Gagal di
      // sini TIDAK membatalkan profil — dilaporkan jujur supaya operator tahu
      // profilnya ada tapi belum terdaftar A2A.
      let a2aRegistered: boolean | null = null
      let a2aError: string | null = null
      // A2A-CALL-1: agent baru harus bisa MEMANGGIL juga, bukan cuma DIPANGGIL.
      let toolsetAdded: boolean | null = null
      let toolsetError: string | null = null
      let peerAdded: boolean | null = null
      let peerError: string | null = null
      if (serveA2a) {
        try {
          await upsertServedAgent({
            slug: created.name,
            description: created.description,
            advertisedToolsets,
          })
          a2aRegistered = true
        } catch (err) {
          a2aRegistered = false
          a2aError = (err as Error).message
        }
        // No peer/toolset writes here: the served-agent writer is disabled and
        // cross-profile config mutations are not implicit consequences of a
        // create. When a safe serializer exists this can be reconsidered.
      }
      return NextResponse.json(
        {
          success: true,
          action,
          name: created.name,
          description: created.description,
          role: created.role,
          division: created.division,
          domains: created.domains,
          /** Preview soul yang tertulis (template atau prompt Jun). */
          soulPreview: soul.trim() || soulFor(created.role, created.name, created.division, created.domains),
          /** Model yang BENAR-BENAR terpasang; null = bawaan Hermes. */
          model: modelApplied,
          provider: providerApplied,
          /** Model yang diminta tapi gagal dipasang (profil tetap dibuat). */
          modelRequested: model || null,
          modelError,
          /**
           * Toggle A2A: null = Mati eksplisit (serveA2a:false — config tidak
           * disentuh). true = terdaftar; false+gagal = pendaftaran gagal.
           */
          a2aRegistered,
          a2aError,
          /** Toolset a2a di profil baru (GABUNG): null = toggle mati. */
          toolsetAdded,
          toolsetError,
          /** Peer `<nama>-local` terdaftar: null = toggle mati. */
          peerAdded,
          peerError,
          /**
           * Jujur soal arti "terdaftar": daftar served-agent baru berlaku
           * setelah gateway di-restart — bukan langsung aktif.
           */
          a2aNote:
            a2aRegistered === true
              ? 'Đã lưu. Có hiệu lực sau khi khởi động lại gateway — trước đó chưa thể gọi tác tử.'
              : null,
          /**
           * Keadaan "butuh restart" SESUDAH tulis ini — SATU sumber kebenaran
           * yang sama dengan doctor. Pop up memakainya: tidak menghitung ulang.
           */
          needsGatewayRestart: await readNeedsGatewayRestart(),
        },
        { status: 201 },
      )
    } catch (err) {
      const msg = (err as Error).message
      // "sudah ada" and the name-format error are the caller's fault, not a fault.
      const isUserError = /sudah ada|nama profil harus/.test(msg)
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

  try {
    // `spawn` and `hide` accept anything the install knows, otherwise a typo would
    // create a hide-list entry matching nothing. `kill` must NOT go through this
    // check: a name with tasks but no profile is exactly the case it needs to
    // handle (the tasks still have to be removed), and the guard rejected it as
    // "tidak dikenal".
    if (action === 'spawn' || action === 'hide') {
      const known = new Set([
        ...(await listAssignees()).map((a) => a.name),
        ...(await listProfiles()),
      ])
      if (!known.has(name)) {
        return NextResponse.json(
          {
            error: {
              code: 'invalid_request',
              message: `Hồ sơ "${name}" không xác định`,
              status: 400,
            },
          },
          { status: 400 },
        )
      }
    }

    /* -------------------------------------------------------------- hide --- */
    // Membership only: the avatar leaves, the profile and its tasks are untouched.
    // This is the safe path, and the ONLY one offered for a name that has no
    // profile on disk but still owns tasks.
    if (action === 'hide') {
      const changed = hide(cleanName)
      return NextResponse.json({
        success: true,
        action,
        name,
        /** false when the name was already hidden. */
        changed,
        hidden: hiddenNames(),
      })
    }

    /* -------------------------------------------------------------- kill --- */
    // `kill` DELETES the profile and purges its tasks. It is the destructive one;
    // hiding is the membership toggle above.
    if (action === 'kill') {
      // `default` lives at ~/.hermes itself, not under profiles/, so the disk
      // check below would refuse it with a misleading "tidak ada di disk".
      if (cleanName === 'default') {
        return NextResponse.json(
          {
            error: {
              code: 'invalid_request',
              message: 'Không thể xóa hồ sơ "default"',
              status: 400,
            },
          },
          { status: 400 },
        )
      }

      /* ---- 1. the tasks ---- */
      // Killing an agent deletes its work too, which is what "kill" should mean —
      // otherwise the board fills with tasks belonging to nobody.
      const owned = await tasksForAssignee(cleanName)
      // Refuse while any of them is live. Archiving a running task abandons the
      // worker mid-flight and the CLI will do it without complaint.
      const active = owned.filter((t) => t.status === 'running' || t.status === 'review')
      if (active.length) {
        return NextResponse.json(
          {
            error: {
              code: 'invalid_request',
              message:
                `${name} có ${active.length} công việc vẫn đang chạy ` +
                `(${active.map((t) => t.id).join(', ')}). Hãy dừng trước khi xóa.`,
              status: 409,
            },
          },
          { status: 409 },
        )
      }

      /* ---- 2. the profile ---- */
      const hasProfile = (await listProfiles()).includes(cleanName)
      if (!hasProfile && !owned.length) {
        // Nothing at all: no profile, no tasks. Explain rather than report a
        // failed delete.
        return NextResponse.json(
          {
            error: {
              code: 'no_profile',
              message: `"${cleanName}" không có hồ sơ hay công việc — không có gì để xóa.`,
              status: 409,
            },
          },
          { status: 409 },
        )
      }

      let purged = 0
      try {
        if (owned.length) {
          const r = await purgeTasks(owned.map((t) => t.id))
          purged = r.purged
        }
        if (hasProfile) await deleteProfile(cleanName)
      } catch (err) {
        const msg = (err as Error).message
        // Refusals (default, gateway running) are the caller's, not a server fault.
        const refused = /tidak bisa dihapus|sedang berjalan|wajib diisi/.test(msg)
        return NextResponse.json(
          {
            error: {
              code: refused ? 'invalid_request' : 'action_failed',
              message:
                purged > 0
                  ? `${purged} công việc đã được xóa, nhưng xóa hồ sơ thất bại: ${msg}`
                  : msg,
              status: refused ? 400 : 502,
            },
          },
          { status: refused ? 400 : 502 },
        )
      }

      // Clear any membership entry: a stale entry would block a future profile
      // that reuses the name.
      show(cleanName)
      // Cleanup failures never turn a completed delete into a 502.
      // 1. A2A served entry: writer disabled (HVO-01), so this is reported, not
      // attempted. It must be removed manually from gateway config.
      let a2aRemoved: boolean | null = null
      let a2aError: string | null = null
      try {
        a2aRemoved = (await removeServedAgent(cleanName)).removed
      } catch (err) {
        a2aRemoved = false
        a2aError = (err as Error).message
      }
      // 2. Peer cleanup is intentionally NOT performed here: writing/config
      // touching OTHER profiles as a side effect of kill is a cross-profile
      // mutation. Report it for manual recovery instead.
      const peerRemoved: boolean | null = null
      const peerError: string | null =
        'Không tự động thu hồi peer giữa các hồ sơ — hãy kiểm tra a2a_agents thủ công'
      const peerProfilesRemoved: string[] = []
      // 3. Avatar row only. HVO-11: NO recursive directory removal here. A
      // task-only assignee has no profile directory, and `profiles/<name>` is
      // not ours to delete after `hermes profile delete` has run.
      const avatarRemoved = deleteAvatar(`agent:${cleanName}`)
      return NextResponse.json({
        success: true,
        action,
        name: cleanName,
        /** The profile no longer exists (false when it was already gone). */
        deleted: hasProfile,
        /** How many of its tasks were removed from the board. */
        purged,
        /** Entri A2A tercabut? null = langkah dilewati (profil tak ada dari awal). */
        a2aRemoved: hasProfile ? a2aRemoved : null,
        a2aError,
        /** Peer `<nama>-local` tercabut? null = langkah dilewati. */
        peerRemoved: hasProfile ? peerRemoved : null,
        peerError,
        /** Profil yang ikut dibersihkan peer-nya. */
        peerProfilesRemoved: hasProfile ? peerProfilesRemoved : null,
        /** Baris avatar `agent:<nama>` terhapus dari kantor? */
        avatarRemoved,
        /** HVO-11: recursive post-kill directory cleanup was removed entirely. */
        dirRemoved: false,
        dirError: null,
        cleanupDeferred:
          'Không tự động xóa thư mục hồ sơ còn sót lại (nếu có) — hãy kiểm tra, sao lưu rồi khôi phục/xóa thủ công',
        /**
         * Jujur soal waktu berlaku: daftar served-agent dibaca SEKALI saat
         * gateway boot — pencabutan baru berlaku setelah gateway di-restart.
         * Sampai itu, path A2A-nya masih dijawab server yang sedang jalan.
         */
        a2aNote:
          a2aRemoved === true
            ? 'Đã gỡ khỏi cấu hình. Có hiệu lực sau khi khởi động lại gateway — trước đó đường dẫn A2A vẫn trả lời.'
            : null,
        hidden: hiddenNames(),
      })
    }

    /* ------------------------------------------------------------- spawn --- */
    // A built-in exclusion cannot be undone. Answer honestly instead of reporting
    // `success: true, changed: false` — the caller would think the click worked.
    if (BUILTIN_HIDDEN.has(name)) {
      return NextResponse.json(
        {
          error: {
            code: 'invalid_request',
            message: `Hồ sơ "${name}" là hồ sơ mặc định của Hermes, không thể đưa vào văn phòng`,
            status: 400,
          },
        },
        { status: 400 },
      )
    }
    const changed = show(cleanName)
    return NextResponse.json({
      success: true,
      action,
      name,
      /** false when the profile was already visible. */
      changed,
      hidden: hiddenNames(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'action_failed', message: (err as Error).message, status: 502 } },
      { status: 502 },
    )
  }
}
