import { NextResponse } from 'next/server'
import { CHAT_LIVE_MS, type A2aPair } from '@/lib/office/duty'
import { a2aLivePairs } from '@/lib/hermes/a2a-transcript'
import { readA2aTranscript } from '@/lib/hermes/a2a-transcript-server'
import { listAgents, listProfiles, listTasks } from '@/lib/hermes/kanban'
import { assertApiRequest } from '@/lib/api-policy'
import { swr } from '@/lib/swr'

export const dynamic = 'force-dynamic'

/**
 * Pasangan A2A yang masih hidup — untuk kantor (avatar jalan ke meja peer).
 *
 * Dipoll tiap beberapa detik seperti `?live=1` dan `?pulse=1`. Di belakangnya ada N export CLI
 * (satu per profil, jalan paralel) — beberapa detik. Jawaban lama dikembalikan SEKETIKA selama
 * 20 dtk (segar) sampai 5 mnt (basi, sambil diperbarui di latar), supaya satu putaran poll tidak
 * menunggu export: poll menunggu jawaban TERLAMBAT dari semua endpoint-nya.
 */
const MEMO_MS = 20_000
const MAX_STALE_MS = 5 * 60_000

const livePairs = swr(
  async () => {
    const now = Date.now()
    const agents = await listAgents(await listTasks())
    const deskOf = new Map(agents.map((a) => [a.name, a.deskIndex ?? null]))
    const profiles = (await listProfiles()).filter((p) => p !== 'default')
    const t = await readA2aTranscript(profiles)
    const pairs: A2aPair[] = a2aLivePairs(t.conversations, now, CHAT_LIVE_MS).map((l) => ({
      agent: l.agent,
      peer: l.peer,
      peerDesk: l.peer !== null ? (deskOf.get(l.peer) ?? null) : null,
    }))
    return { pairs, at: new Date(now).toISOString() }
  },
  { freshMs: MEMO_MS, maxStaleMs: MAX_STALE_MS },
)

export async function GET(req: Request) {
  const denied = assertApiRequest(req, 'read')
  if (denied) return denied
  try {
    return NextResponse.json(await livePairs())
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'a2a_live_failed', message: (err as Error).message, status: 502 } },
      { status: 502 },
    )
  }
}
