import { NextRequest, NextResponse } from 'next/server'
import {
  claimAvatar,
  setAvatarDisplay,
  resetAvatarDisplay,
  validateAvatarDisplay,
  getOfficeName,
  listAvatars,
  saveAvatars,
  seedAvatars,
  setOfficeName,
  type AvatarWrite,
} from '@/lib/office/db'
import { listProfiles, listAssignees } from '@/lib/hermes/kanban'
import { isSafeProfileName } from '@/lib/hermes/profile-name'
import { dummyRoster } from '@/lib/office/dummy-roster'
import { assertApiRequest } from '@/lib/api-policy'
import type { AgentDivision } from '@/types/hermes'

export const dynamic = 'force-dynamic'

/**
 * The office's own store: name and avatar positions/activities.
 *
 * This is deliberately separate from `/api/hermes/*` (tasks, agents, cron,
 * meeting). Those read the Hermes CLI; this reads `data/office.db`, which belongs
 * to the office itself. Keeping them apart means a broken Hermes install still
 * lets the room render, and the office's own tables never risk the CLI's schema.
 */
export async function GET(req: NextRequest) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  try {
    // First run: populate the dummy roster so the building is not empty. Idempotent
    // — it only fires when the table has no rows at all.
    seedAvatars(dummyRoster())
    return NextResponse.json({
      name: getOfficeName(),
      avatars: listAvatars(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'office_db_failed', message: (err as Error).message, status: 500 } },
      { status: 500 },
    )
  }
}

type Body = {
  displayName?: unknown
  divisionOverride?: unknown
  roleLabel?: unknown
  useHermesDivision?: unknown
  action?: string
  name?: string
  avatarId?: string
  list?: AvatarWrite[]
  asker?: string
  responsible?: string
  question?: string
  id?: number
  answer?: string
}

const DIVISIONS: AgentDivision[] = ['exec', 'tech', 'growth', 'content']

/** Clamp a raw avatar write so a malformed client cannot poison the table. */
function cleanAvatar(raw: unknown): AvatarWrite | null {
  const a = raw as Partial<AvatarWrite>
  if (!a?.avatarId || !a?.name) return null
  const division = DIVISIONS.includes(a.division as AgentDivision) ? (a.division as AgentDivision) : 'tech'
  return {
    ...validateAvatarDisplay(a),
    avatarId: String(a.avatarId),
    name: String(a.name),
    division,
    kind: a.kind === 'agent' ? 'agent' : 'dummy',
    x: Number(a.x) || 0,
    z: Number(a.z) || 0,
    level: Number(a.level) || 0,
    activity: String(a.activity || 'idle'),
    facing: Number(a.facing) || 0,
    spawned: !!a.spawned,
    // An anchored body is pinned: the receptionist must never wander (poin 2).
    anchored: !!a.anchored,
  }
}

export async function POST(req: NextRequest) {
  // Same-origin write guard, exactly like the other mutating routes: this server
  // is exposed on a public port, and these actions write to disk.
  const denied = assertApiRequest(req, 'office-write')
  if (denied) return denied

  const raw: unknown = await req.json().catch(() => null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return NextResponse.json({ error: { code: 'invalid_request', message: 'Invalid body', status: 400 } }, { status: 400 })
  }
  const body = raw as Body
  try {
    switch (body.action) {
      case 'setAvatarDisplay':
      case 'resetAvatarDisplay': {
        try {
          if (typeof body.avatarId !== 'string' || !body.avatarId.trim()) throw new Error('Invalid avatarId')
          validateAvatarDisplay(body)
        } catch (err) {
          return NextResponse.json({ error: { code: 'invalid_request', message: (err as Error).message, status: 400 } }, { status: 400 })
        }
        let seedName: string | undefined
        if (!listAvatars().some((a) => a.avatarId === body.avatarId)) {
          const name = body.avatarId!.startsWith('agent:') ? body.avatarId!.slice(6) : ''
          if (!isSafeProfileName(name, { allowDefault: true }) || body.avatarId !== `agent:${name}`) {
            return NextResponse.json({ error: { code: 'invalid_request', message: 'Invalid avatar identity', status: 400 } }, { status: 400 })
          }
          // Read roster only: never create/spawn a Hermes profile or alter membership.
          const profiles = await listProfiles()
          if (!profiles.includes(name) && !(await listAssignees()).some((a) => a.name === name)) {
            return NextResponse.json({ error: { code: 'not_found', message: 'Agent not found', status: 404 } }, { status: 404 })
          }
          seedName = name
        }
        const avatar = body.action === 'resetAvatarDisplay'
          ? resetAvatarDisplay(body.avatarId!, seedName) : setAvatarDisplay(body.avatarId!, body, seedName)
        if (!avatar) return NextResponse.json({ error: { code: 'not_found', message: 'Avatar not found', status: 404 } }, { status: 404 })
        return NextResponse.json({ avatar })
      }
      case 'setName': {
        return NextResponse.json({ name: setOfficeName(String(body.name ?? '')) })
      }
      case 'saveAvatars': {
        try {
          if (!Array.isArray(body.list)) throw new Error('Invalid list')
          for (const row of body.list) validateAvatarDisplay(row)
        } catch (err) {
          return NextResponse.json({ error: { code: 'invalid_request', message: (err as Error).message, status: 400 } }, { status: 400 })
        }
        const list = (Array.isArray(body.list) ? body.list : [])
          .map(cleanAvatar)
          .filter((a): a is AvatarWrite => a !== null)
        return NextResponse.json({ saved: saveAvatars(list) })
      }
      case 'claimAvatar': {
        // Klaim slot dummy untuk agent: SATU agent = SATU baris kanonik
        // `agent:<nama>`. Baris kanonik yang sudah ada DIPINDAH ke posisi
        // slot (bukan dibuatkan badan kedua) — itu yang dihapus `kill`.
        const avatarId = String(body.avatarId ?? '')
        const claimName = String(body.name ?? '').trim().toLowerCase()
        if (!avatarId || !claimName) {
          return NextResponse.json(
            { error: { code: 'invalid_request', message: 'claimAvatar cần avatarId + name', status: 400 } },
            { status: 400 },
          )
        }
        try {
          const r = claimAvatar(avatarId, claimName)
          return NextResponse.json({ claimed: true, avatarId: r.avatarId, moved: r.moved, slotRemoved: r.slotRemoved })
        } catch (err) {
          return NextResponse.json(
            { error: { code: 'action_failed', message: (err as Error).message, status: 502 } },
            { status: 502 },
          )
        }
      }
      default:
        return NextResponse.json(
          { error: { code: 'invalid_request', message: `action không xác định: ${body.action}`, status: 400 } },
          { status: 400 },
        )
    }
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'office_write_failed', message: (err as Error).message, status: 500 } },
      { status: 500 },
    )
  }
}
