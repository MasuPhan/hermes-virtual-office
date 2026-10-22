import type { Agent } from '@/types/hermes'
import { DESKS, deskByIndex, mayEnterCeoRoom } from './layout'
import { officeDivision, type AvatarState } from './types'

/** Settings rows are not membership. A hidden real profile must never become a dummy. */
export function sceneRows(rows: AvatarState[], agents: Pick<Agent, 'name'>[]): AvatarState[] {
  const names = new Set(agents.map((a) => a.name))
  return rows.filter((r) => r.kind === 'dummy' || names.has(r.name))
}

/** Office-only seats, retaining Hermes assignments when using Hermes defaults. */
export function officeSeats(agents: Agent[], rows: AvatarState[]): Map<string, number> {
  const out = new Map<string, number>()
  const occupied = new Set<number>()
  const ordered = [...agents].sort((a, b) => a.name.localeCompare(b.name))
  const settings = new Map(rows.map((r) => [r.name, r]))
  const allowed = (a: Agent, d: typeof DESKS[number]) => d.level === 0 || mayEnterCeoRoom(a.role)
  for (const agent of ordered) {
    const row = settings.get(agent.name) ?? { useHermesDivision: true }
    const desk = agent.deskIndex == null ? undefined : deskByIndex(agent.deskIndex)
    if (desk && !occupied.has(desk.index) && allowed(agent, desk) &&
      (row.useHermesDivision !== false || desk.division === officeDivision(row, agent.division))) {
      out.set(agent.name, desk.index); occupied.add(desk.index)
    }
  }
  for (const agent of ordered) {
    const row = settings.get(agent.name)
    if (!row || row.useHermesDivision !== false || out.has(agent.name)) continue
    const desk = DESKS.find((d) => d.division === officeDivision(row, agent.division) && !occupied.has(d.index) && allowed(agent, d))
    if (desk) { out.set(agent.name, desk.index); occupied.add(desk.index) }
  }
  return out
}

/** A presentation copy only: name, role and task assignment retain canonical identity. */
export function officeAgents(agents: Agent[], rows: AvatarState[]): Agent[] {
  const seats = officeSeats(agents, rows)
  return agents.map((agent) => {
    const row = rows.find((r) => r.avatarId === `agent:${agent.name}`)
    if (!row) return agent
    return { ...agent, displayName: row.displayName ?? agent.displayName,
      division: officeDivision(row, agent.division), deskIndex: seats.get(agent.name) ?? null }
  })
}
