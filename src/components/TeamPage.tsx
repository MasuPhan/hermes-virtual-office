'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchJson } from '@/lib/api'
import AgentAvatar from './AgentAvatar'
import { formatLocale, t as translate, type MessageKey } from '@/lib/i18n'
import type { Team, TeamMember } from '@/lib/hermes/team'
import type { AgentDivision, AgentStatus, TaskStatus } from '@/types/hermes'

type TeamReply = Team & { readAt: string }
type Filter = 'all' | 'working' | 'blocked' | 'idle'

const POLL_MS = 30_000
const DIVISIONS: (AgentDivision | null)[] = ['exec', 'tech', 'growth', 'content', null]
/** Bar order: work in hand first, finished last. */
const BAR: TaskStatus[] = ['running', 'review', 'blocked', 'ready', 'todo', 'scheduled', 'triage', 'done']

function divLabel(d: AgentDivision | null): string {
  return translate(`Team.div.${d ?? 'none'}` as MessageKey)
}

function statusLabel(s: AgentStatus): string {
  return translate(`Team.status.${s}` as MessageKey)
}

function matches(m: TeamMember, f: Filter): boolean {
  if (f === 'all') return true
  if (f === 'working') return m.status === 'working' || m.status === 'review'
  return m.status === f
}

const rtf = new Intl.RelativeTimeFormat(formatLocale, { numeric: 'auto' })
function ago(iso: string): string {
  const sec = (new Date(iso).getTime() - Date.now()) / 1000
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12]]
  let v = sec
  for (const [unit, size] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit)
    v /= size
  }
  return rtf.format(Math.round(v), 'year')
}

function taskHref(id: string, board?: string): string {
  return `/kanban?task=${encodeURIComponent(id)}${board ? `&board=${encodeURIComponent(board)}` : ''}`
}

function MemberCard({ m }: { m: TeamMember }) {
  const total = BAR.reduce((n, s) => n + (m.counts[s] ?? 0), 0)
  return (
    <article className="vp-team-card" data-status={m.status}>
      <header className="vp-team-card-head">
        <AgentAvatar name={m.name} role={m.role} status={m.status} />
        <div className="vp-team-id">
          <div className="vp-team-name">
            <b>{m.displayName}</b>
            {m.displayName !== m.name && <span className="vp-muted"> @{m.name}</span>}
          </div>
          <div className="vp-muted vp-team-meta">
            {[m.role, m.model ?? translate('Team.noModel')].filter(Boolean).join(' · ')}
            {m.hidden && <span className="vp-team-tag">{translate('Team.hidden')}</span>}
            {!m.soulExists && <span className="vp-team-tag">{translate('Team.noSoul')}</span>}
          </div>
        </div>
        <span className="vp-team-pill" data-status={m.status}>{statusLabel(m.status)}</span>
      </header>
      {m.domains.length > 0 && (
        <div className="vp-team-domains">
          {m.domains.map((d) => (
            <span key={d} className="vp-team-tag">{d}</span>
          ))}
        </div>
      )}
      <div className="vp-team-current">
        {m.currentTask ? (
          <>
            <span className="vp-muted">{translate('Team.current')} </span>
            <Link href={taskHref(m.currentTask.id, m.currentTask.board)}>{m.currentTask.title}</Link>
          </>
        ) : (
          <span className="vp-muted">{translate('Team.noCurrent')}</span>
        )}
      </div>
      <div className="vp-team-nums">
        <span><b>{m.open}</b> {translate('Team.open')}</span>
        <span><b>{m.done}</b> {translate('Team.done')}</span>
        <span title={translate('Team.delegatedOut')}>↗ <b>{m.delegatedOut}</b> {translate('Team.delegatedOut')}</span>
        <span title={translate('Team.delegatedIn')}>↘ <b>{m.delegatedIn}</b> {translate('Team.delegatedIn')}</span>
      </div>
      {total > 0 && (
        <div className="vp-team-bar" role="img" aria-label={BAR.filter((s) => m.counts[s]).map((s) => `${translate(`Team.st.${s}` as MessageKey)}: ${m.counts[s]}`).join(', ')}>
          {BAR.filter((s) => m.counts[s]).map((s) => (
            <span
              key={s}
              data-st={s}
              style={{ flexGrow: m.counts[s] }}
              title={`${translate(`Team.st.${s}` as MessageKey)}: ${m.counts[s]}`}
            />
          ))}
        </div>
      )}
      <footer className="vp-team-foot vp-muted">
        <span>{m.lastActivity ? translate('Team.lastActivity', { when: ago(m.lastActivity) }) : translate('Team.never')}</span>
        {m.boards.length > 0 && (
          <span>
            {translate('Team.boards')}{' '}
            {m.boards.map((b) => (
              <Link key={b.slug} className="vp-team-board" href={`/kanban?board=${encodeURIComponent(b.slug)}`}>
                {b.slug} {b.open}
              </Link>
            ))}
          </span>
        )}
      </footer>
    </article>
  )
}

/** /team — "Đội AI": every Hermes profile and what it holds across all boards. Read-only. */
export default function TeamPage() {
  const [team, setTeam] = useState<TeamReply | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(async () => {
    const res = await fetchJson<TeamReply>('/api/hermes/team')
    if (res.ok && res.data) {
      setTeam(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const groups = useMemo(() => {
    const shown = (team?.members ?? []).filter((m) => matches(m, filter))
    return DIVISIONS.map((d) => ({ d, members: shown.filter((m) => m.division === d) })).filter((g) => g.members.length)
  }, [team, filter])

  const s = team?.summary
  const tiles: { key: string; n: number; label: string; tone?: string; filter?: Filter }[] = s
    ? [
        { key: 'agents', n: s.agents, label: translate('Team.sumAgents'), filter: 'all' },
        { key: 'working', n: s.working, label: translate('Team.sumWorking'), tone: 'accent', filter: 'working' },
        { key: 'blocked', n: s.blocked, label: translate('Team.sumBlocked'), tone: s.blocked ? 'red' : undefined, filter: 'blocked' },
        { key: 'idle', n: s.idle, label: translate('Team.sumIdle'), filter: 'idle' },
        { key: 'open', n: s.openTasks, label: `${translate('Team.sumOpen')} · ${translate('Team.sumBoards', { n: s.boards })}` },
        { key: 'triage', n: s.triageUnassigned, label: translate('Team.sumTriage'), tone: s.triageUnassigned ? 'amber' : undefined },
      ]
    : []

  return (
    <div className="vp-kpage">
      <header className="vp-kpage-head">
        <img className="vp-logo-img" src="/oxmode-logo.png" alt="OXMODE" width={126} height={18} />
        <h1>{translate('Team.heading')}</h1>
        <span className="vp-muted vp-kpage-stat">
          {error ? (
            <span className="vp-err">{error}</span>
          ) : team ? (
            translate('Team.readAt', { time: new Date(team.readAt).toLocaleTimeString(formatLocale) })
          ) : (
            translate('Team.loading')
          )}
        </span>
        <div className="vp-kpage-back vp-team-nav">
          <Link className="vp-chip-btn" href="/kanban">{translate('Team.openKanban')}</Link>
          <Link className="vp-chip-btn" href="/">⤡ {translate('Kanban.backToOffice')}</Link>
        </div>
      </header>
      <main className="vp-kpage-body vp-team">
        {s && (
          <section className="vp-team-sum" aria-label={translate('Team.heading')}>
            {tiles.map((x) => {
              const body = (
                <>
                  <b data-tone={x.tone}>{x.n}</b>
                  <span>{x.label}</span>
                </>
              )
              return x.filter ? (
                <button
                  key={x.key}
                  type="button"
                  className={`vp-team-tile${filter === x.filter ? ' on' : ''}`}
                  aria-pressed={filter === x.filter}
                  onClick={() => setFilter(x.filter!)}
                >
                  {body}
                </button>
              ) : (
                <div key={x.key} className="vp-team-tile">{body}</div>
              )
            })}
          </section>
        )}
        {s && s.orphans.length > 0 && (
          <p className="vp-team-warn">
            {translate('Team.orphans')} {s.orphans.map((o) => `${o.name} (${o.open})`).join(', ')}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.d ?? 'none'} className="vp-team-group">
            <h2 className="vp-sub">{divLabel(g.d)} · {g.members.length}</h2>
            <div className="vp-team-grid">
              {g.members.map((m) => (
                <MemberCard key={m.name} m={m} />
              ))}
            </div>
          </section>
        ))}
        {team && groups.length === 0 && <p className="vp-muted">{translate('Team.empty')}</p>}
      </main>
    </div>
  )
}
