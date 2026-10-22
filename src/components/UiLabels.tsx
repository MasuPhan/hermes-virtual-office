
import { t as translate } from '@/lib/i18n'
import type { AgentDivision, AgentRole } from '@/types/hermes'

/** Display-only translations; protocol values and stored data stay unchanged. */
export const UI_ROLE_LABEL: Record<AgentRole, string> = {
  ceo: 'CEO',
  orchestrator: translate("UiLabels.text1"),
  manager: translate("UiLabels.text2"),
  backend: translate("UiLabels.text3"),
  frontend: translate("UiLabels.text4"),
  qa: translate("UiLabels.text5"),
  researcher: translate("UiLabels.text6"),
  devops: 'DevOps',
  marketing: translate("UiLabels.text7"),
  seo: 'SEO',
  content: translate("UiLabels.text8"),
  affiliator: translate("UiLabels.text9"),
}

export const UI_DIVISION_LABEL: Record<AgentDivision, string> = {
  exec: translate("UiLabels.text10"),
  tech: translate("UiLabels.text11"),
  growth: translate("UiLabels.text12"),
  content: translate("UiLabels.text13"),
}

const STATE_LABEL: Record<string, string> = {
  todo: translate("UiLabels.text14"),
  triage: translate("UiLabels.text15"),
  ready: translate("UiLabels.text16"),
  scheduled: translate("UiLabels.text17"),
  queued: translate("UiLabels.text18"),
  menunggu: translate("UiLabels.text19"),
  round1: translate("UiLabels.text20"),
  round2: translate("UiLabels.text21"),
  round3: translate("UiLabels.text22"),
  round4: translate("UiLabels.text23"),
  running: translate("UiLabels.text24"),
  working: translate("UiLabels.text25"),
  review: translate("UiLabels.text26"),
  blocked: translate("UiLabels.text27"),
  done: translate("UiLabels.text28"),
  completed: translate("UiLabels.text29"),
  success: translate("UiLabels.text30"),
  failed: translate("UiLabels.text31"),
  failure: translate("UiLabels.text32"),
  error: translate("UiLabels.text33"),
  idle: translate("UiLabels.text34"),
  cancelled: translate("UiLabels.text35"),
  canceled: translate("UiLabels.text36"),
  archived: translate("UiLabels.text37"),
  paused: translate("UiLabels.text38"),
  active: translate("UiLabels.text39"),
  enabled: translate("UiLabels.text40"),
  disabled: translate("UiLabels.text41"),
  meeting: translate("UiLabels.text42"),
  opening: translate("UiLabels.text43"),
  speech: translate("UiLabels.text44"),
  minutes: translate("UiLabels.text45"),
  preparing: translate("UiLabels.text46"),
  discussion: translate("UiLabels.text47"),
  concluding: translate("UiLabels.text48"),
  finalizing: translate("UiLabels.text49"),
  complete: translate("UiLabels.text50"),
}

export const UI_ORIGIN_LABEL: Record<string, string> = {
  meeting: translate("UiLabels.text51"),
  cron: translate("UiLabels.text52"),
  agent: translate("UiLabels.text53"),
  manual: translate("UiLabels.text54"),
}

export const UI_ACTION_LABEL: Record<string, string> = {
  pauseAll: translate("UiLabels.text55"),
  resumeAll: translate("UiLabels.text56"),
  unblock: translate("UiLabels.text57"),
  release: translate("UiLabels.text58"),
  setFallback: translate("UiLabels.text59"),
}

export function uiState(value: string): string {
  return STATE_LABEL[value] ?? value
}
