'use client'

import { useEffect, useMemo, useState } from 'react'
import AgentAvatar from './AgentAvatar'
import { usePresence } from './usePresence'
import { useOffice } from '@/lib/store'
import { t as translate } from '@/lib/i18n'
import {
  PRESENCE_GROUPS,
  presenceDot,
  presenceGroup,
  presenceSummary,
  type PresenceGroup,
  type PresenceRow,
} from '@/lib/office/presence'

const STORE_KEY = 'hvo.roster.collapsed'
/** /api/hermes/team answers from a stale-while-revalidate cache, so this is cheap. */
const TEAM_POLL_MS = 15_000

export function describePresence(r: PresenceRow): string {
  switch (r.kind) {
    case 'meeting':
      return translate('Roster.meeting', { topic: r.topic || '…' })
    case 'talking':
      return r.peer ? translate('Roster.talking', { peer: r.peer }) : translate('Roster.talkingUnknown')
    case 'working':
      return r.task ? translate('Roster.working', { task: r.task }) : translate('Roster.workingNoTask')
    case 'chat':
      return translate('Roster.chat')
    case 'reporting':
      return translate('Roster.reporting')
    case 'review':
      return r.task ? translate('Roster.review', { task: r.task }) : translate('Roster.reviewNoTask')
    case 'blocked':
      return r.blockedCards ? translate('Roster.blocked', { n: r.blockedCards }) : translate('Roster.blockedNoCount')
    default:
      return r.queued ? translate('Roster.idleQueued', { n: r.queued }) : translate('Roster.idle')
  }
}

/**
 * Who is doing what, at a glance, over the 3D / pixel view — so the operator reads the state
 * of the whole team without clicking an avatar. One line per agent, the ones that need the
 * operator first. Collapses to the four counts; the choice is remembered per browser.
 */
export default function AgentStatusOverlay() {
  const agents = useOffice((s) => s.agents)
  const loadTeam = useOffice((s) => s.loadTeam)
  const select = useOffice((s) => s.select)
  const selected = useOffice((s) => s.selectedAgent)

  // null until mounted: the stored choice and the screen width are only known in the browser.
  const [collapsed, setCollapsed] = useState<boolean | null>(null)

  useEffect(() => {
    let stored: string | null = null
    try {
      stored = localStorage.getItem(STORE_KEY)
    } catch {
      // storage blocked: fall back to the default below
    }
    setCollapsed(stored === null ? window.innerWidth < 720 : stored === '1')
  }, [])

  useEffect(() => {
    void loadTeam()
    const id = setInterval(() => void loadTeam(), TEAM_POLL_MS)
    return () => clearInterval(id)
  }, [loadTeam])

  const roles = useMemo(() => new Map(agents.map((a) => [a.name, a.role])), [agents])
  const rows = usePresence()
  const sum = presenceSummary(rows)

  if (collapsed === null) return null

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(STORE_KEY, next ? '1' : '0')
    } catch {
      // per-browser convenience only
    }
  }

  const groupLabel: Record<PresenceGroup, string> = {
    waiting: translate('Roster.groupWaiting'),
    together: translate('Roster.groupTogether'),
    working: translate('Roster.groupWorking'),
    idle: translate('Roster.groupIdle'),
  }
  const counts: Record<PresenceGroup, string> = {
    waiting: translate('Roster.sumWaiting', { n: sum.waiting }),
    together: translate('Roster.sumTogether', { n: sum.together }),
    working: translate('Roster.sumWorking', { n: sum.working }),
    idle: translate('Roster.sumIdle', { n: sum.idle }),
  }
  const total = rows.length || 1

  return (
    <aside className="vp-roster" aria-label={translate('Roster.title')}>
      <button
        type="button"
        className="vp-roster-head"
        onClick={toggle}
        aria-expanded={!collapsed}
        title={collapsed ? translate('Roster.expand') : translate('Roster.collapse')}
      >
        <span className="vp-roster-title">
          <b>{translate('Roster.title')}</b>
          <span className="vp-roster-caret" aria-hidden="true">{collapsed ? '＋' : '－'}</span>
        </span>
        <span className="vp-roster-bar" aria-hidden="true">
          {PRESENCE_GROUPS.filter((g) => sum[g] > 0).map((g) => (
            <i key={g} data-g={g} style={{ flexGrow: sum[g] / total }} />
          ))}
        </span>
        <span className="vp-roster-counts">
          {PRESENCE_GROUPS.filter((g) => sum[g] > 0).map((g) => (
            <span key={g} data-g={g}>
              {counts[g]}
            </span>
          ))}
        </span>
      </button>
      {!collapsed && (
        <div className="vp-roster-body">
          {rows.length === 0 && <p className="vp-muted vp-roster-empty">{translate('Roster.empty')}</p>}
          {PRESENCE_GROUPS.map((g) => {
            const inGroup = rows.filter((r) => presenceGroup(r.kind) === g)
            if (!inGroup.length) return null
            return (
              <section key={g} className="vp-roster-sec" data-g={g}>
                <h3>{groupLabel[g]}</h3>
                <ul>
                  {inGroup.map((r) => {
                    const text = describePresence(r)
                    return (
                      <li key={r.name}>
                        <button
                          type="button"
                          className="vp-roster-row"
                          data-sel={selected === r.name ? '1' : undefined}
                          onClick={() => select(r.name)}
                          title={`${r.name} — ${text}`}
                        >
                          <AgentAvatar name={r.name} role={roles.get(r.name) ?? null} status={presenceDot(r.kind)} size={32} />
                          <span className="vp-roster-txt">
                            <b>{r.name}</b>
                            <span>{text}</span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </aside>
  )
}
