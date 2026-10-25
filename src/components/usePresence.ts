'use client'

import { useMemo } from 'react'
import { useOffice } from '@/lib/store'
import { presenceRows, type PresenceRow } from '@/lib/office/presence'

/**
 * One line per agent, from the signals the office already polls. The roster overlay and the
 * agent panel both read THIS, so the status in the list and the status in the panel that
 * opens from it can never disagree.
 */
export function usePresence(): PresenceRow[] {
  const agents = useOffice((s) => s.agents)
  const meeting = useOffice((s) => s.meeting)
  const work = useOffice((s) => s.work)
  const team = useOffice((s) => s.team)
  return useMemo(
    () =>
      presenceRows({
        agents,
        meeting,
        a2a: work.a2a ?? [],
        chatLive: work.chatLive ?? [],
        reporting: work.reporting ?? [],
        blockedCards: Object.fromEntries(team.map((m) => [m.name, m.counts.blocked ?? 0])),
        queuedCards: Object.fromEntries(
          team.map((m) => [m.name, (m.counts.ready ?? 0) + (m.counts.todo ?? 0) + (m.counts.scheduled ?? 0)]),
        ),
      }),
    [agents, meeting, work, team],
  )
}
