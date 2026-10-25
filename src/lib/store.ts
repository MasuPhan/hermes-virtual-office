'use client'

import { create } from 'zustand'
import type { Agent, ArchivedMeeting, Meeting, Task } from '@/types/hermes'
import type { AvatarDisplay, AvatarState } from './office/types'
import type { Health } from './office/health'
import type { CronPulse, WorkSignals, A2aPair } from './office/duty'
import type { TeamMember } from './hermes/team'
import { fetchJson, setApiBoard } from './api'
import { t as translate } from './i18n'
import { readUrlState, storeBoard, storedBoard, urlView, writeUrlParam } from './kanban-url'

/** One Hermes board, as GET /api/hermes/boards returns it. */
export type BoardInfo = {
  slug: string
  name: string
  icon: string
  color: string
  description: string
  total: number
  counts: Record<string, number>
  current: boolean
}

let displayRevision = 0

const POLL_MS = Number(process.env.NEXT_PUBLIC_POLL_MS || 4000)

type State = {
  /** Hermes board on screen ('' until known = server default). */
  board: string
  boards: BoardInfo[]
  /** What a request without ?board= reads (HERMES_KANBAN_BOARD or the CLI current board). */
  defaultBoard: string
  boardsError: string | null
  /** What the server allows (GET /api/hermes/boards): archive = management, delete = privileged. */
  writes: { management: boolean; privileged: boolean }
  /** Last archive/delete outcome for the Kanban toolbar. */
  kanbanNotice: { kind: 'ok' | 'err'; text: string } | null
  tasks: Task[]
  agents: Agent[]
  meeting: Meeting | null
  meetingConfigured: boolean
  /** Archived meetings on disk, newest first. */
  meetingHistory: ArchivedMeeting[]
  /** Id of the archived transcript currently open, if any. */
  meetingArchive: { id: string; body: string } | null
  loading: boolean
  error: string | null
  view: '3d' | '2d' | 'sprite'
  peekDesk: number | null
  selectedAgent: string | null
  /** Task opened from the 3D board or the 2D board. */
  openTaskId: string | null
  newTaskOpen: boolean

  /** The office's own store (data/office.db), separate from the Hermes CLI data. */
  officeName: string
  avatars: AvatarState[]

  /**
   * Kesehatan sistem, dinilai dari data Hermes yang sebenarnya.
   *
   * Disimpan di store (bukan di dalam panel) karena LAMPU DI LOBBY membacanya. Kalau hanya
   * panel yang punya, lampunya tidak akan pernah tahu apa-apa.
   */
  health: Health

  /**
   * Sinyal kerja di luar kanban: siapa yang sedang diajak chat, cron yang baru jalan,
   * dan pasangan A2A yang masih hidup (agent jalan ke meja lawan bicaranya).
   * Scene membacanya untuk mengirim agent ke mejanya (lihat office/duty.ts).
   */
  work: WorkSignals
  /** Mỗi agent kèm việc trên MỌI board (từ /api/hermes/team): nguồn chung của overlay và panel agent. */
  team: TeamMember[]
  loadTeam: () => Promise<void>
  /** Báo cáo chưa đọc ở Phòng chung (xong / bị chặn). */
  feedUnread: number
  /** Áp kết quả `/api/hermes/feed` (sau khi đánh dấu đã đọc) mà không chờ vòng poll sau. */
  setFeedSummary: (s: { unread: number; reporting: string[] }) => void

  load: () => Promise<void>
  loadBoards: () => Promise<void>
  /** Pick a board: URL + localStorage + every kanban API call. Never runs `boards switch`. */
  setBoard: (slug: string) => void
  /** Archive cards (optimistic) on the board on screen; running cards are refused server-side. */
  archiveTasks: (ids: string[]) => Promise<ArchiveResult>
  /** Permanently delete cards (optimistic); the confirm token binds the request to these ids. */
  deleteTasks: (ids: string[]) => Promise<ArchiveResult>
  setKanbanNotice: (n: State['kanbanNotice']) => void
  /** Read ?board / ?view / ?task (and the stored board) once on mount. */
  initFromUrl: (opts?: { view?: boolean }) => void
  /** Baca sinyal kerja. Gagal = tidak ada sinyal, bukan sinyal lama (lihat badannya). */
  loadWork: () => Promise<void>
  /** Baca kesehatan. Terpisah dari load(), karena kegagalannya tidak boleh menjatuhkan kantor. */
  loadHealth: () => Promise<void>
  loadOffice: () => Promise<void>
  setOfficeName: (name: string) => Promise<void>
  /** Batch position flush from the 3D scene — the DB write behind idle wander. */
  saveAvatars: (list: AvatarState[]) => Promise<void>
  setAvatarDisplay: (avatarId: string, settings: AvatarDisplay | null) => Promise<void>
  setView: (v: '3d' | '2d' | 'sprite') => void
  setPeek: (desk: number | null) => void
  openTask: (taskId: string | null) => void
  select: (name: string | null) => void
  setNewTaskOpen: (v: boolean) => void
  refreshMeeting: () => Promise<void>
}

export const useOffice = create<State>((set, get) => ({
  board: '',
  boards: [],
  defaultBoard: '',
  boardsError: null,
  writes: { management: false, privileged: false },
  kanbanNotice: null,
  tasks: [],
  agents: [],
  meeting: null,
  meetingConfigured: false,
  meetingHistory: [],
  meetingArchive: null,
  loading: true,
  error: null,
  view: '3d',
  peekDesk: null,
  selectedAgent: null,
  openTaskId: null,
  newTaskOpen: false,

  officeName: 'Văn phòng Hermes',
  avatars: [],

  // Mulai dari TIDAK TAHU, bukan dari hijau. Sistem yang belum selesai membaca keadaannya
  // tidak boleh tampil sehat — itu kebohongan yang paling gampang terjadi.
  health: { level: 'warn', reasons: ['Chưa đọc trạng thái hệ thống'] },

  work: { chatLive: [], cron: null, a2a: [], reporting: [] },
  feedUnread: 0,
  team: [],
  async loadTeam() {
    const res = await fetchJson<{ members: TeamMember[] }>('/api/hermes/team', { cache: 'no-store' })
    if (res.ok && res.data) set({ team: res.data.members })
  },
  setFeedSummary: ({ unread, reporting }) => set((st) => ({ feedUnread: unread, work: { ...st.work, reporting } })),

  async loadWork() {
    const [chat, cron, a2a, feed] = await Promise.all([
      fetchJson<{ live?: string[] }>('/api/hermes/chat?live=1', { cache: 'no-store' }),
      fetchJson<{ pulse?: CronPulse | null }>('/api/hermes/cron?pulse=1', { cache: 'no-store' }),
      fetchJson<{ pairs?: A2aPair[] }>('/api/hermes/a2a/live', { cache: 'no-store' }),
      fetchJson<{ unread?: number; reporting?: string[] }>('/api/hermes/feed?summary=1', { cache: 'no-store' }),
    ])
    // Pembacaan yang gagal dianggap "tidak ada kerja": lebih baik agent tetap jalan-jalan
    // daripada terpaku di meja selamanya karena sinyal lama yang tidak pernah padam.
    set({
      work: {
        chatLive: chat.ok ? chat.data?.live ?? [] : [],
        cron: cron.ok ? cron.data?.pulse ?? null : null,
        a2a: a2a.ok ? a2a.data?.pairs ?? [] : [],
        reporting: feed.ok ? feed.data?.reporting ?? [] : [],
      },
      ...(feed.ok ? { feedUnread: feed.data?.unread ?? 0 } : {}),
    })
  },

  async loadHealth() {
    try {
      const res = await fetchJson<{ health?: Health }>('/api/hermes/observability?days=365&hours=24', {
        cache: 'no-store',
      })
      if (!res.ok || !res.data?.health) {
        set({ health: { level: 'bad', reasons: [res.error || 'Không thể đọc trạng thái hệ thống'] } })
        return
      }
      set({ health: res.data.health })
    } catch (e) {
      // Kalau pembacaannya sendiri gagal, itu MERAH — bukan "tetap seperti tadi". Diam
      // beberapa detik itu wajar; tapi menampilkan keadaan lama sebagai sekarang tidak.
      set({ health: { level: 'bad', reasons: [`Không thể đọc trạng thái hệ thống: ${(e as Error).message}`] } })
    }
  },

  async load() {
    const board = get().board
    const res = await fetchJson<{ tasks?: Task[]; agents?: Agent[] }>('/api/hermes/tasks', {
      cache: 'no-store',
    })
    // The user switched boards while this poll was in flight: its rows belong to the old one.
    if (get().board !== board) return
    if (!res.ok || !res.data) {
      set({ error: res.error || 'Không thể tải bảng', loading: false })
      return
    }
    set({ tasks: res.data.tasks || [], agents: res.data.agents || [], error: null, loading: false })
  },

  /**
   * The office's own store. Kept separate from `load()` on purpose: a broken
   * Hermes install (tasks/agents failing) must not stop the room from rendering,
   * and this endpoint reads data/office.db, not the CLI.
   */
  async loadOffice() {
    const revision = displayRevision
    const res = await fetchJson<{
      name?: string
      avatars?: AvatarState[]
    }>('/api/hermes/office', { cache: 'no-store' })
    if (!res.ok || !res.data || revision !== displayRevision) return
    set({
      officeName: res.data.name || 'Văn phòng Hermes',
      avatars: res.data.avatars || [],
    })
  },

  async setOfficeName(name: string) {
    const res = await fetchJson<{ name?: string }>('/api/hermes/office', {
      method: 'POST',
      body: JSON.stringify({ action: 'setName', name }),
    })
    if (res.ok && res.data?.name) set({ officeName: res.data.name })
  },

  /**
   * Position flush from the 3D scene. Fire-and-forget on purpose: the scene calls
   * this every few seconds and a failed write must never stall the render loop.
   * The next flush retries whatever moved.
   */
  async saveAvatars(list: AvatarState[]) {
    if (!list.length) return
    await fetchJson('/api/hermes/office', {
      method: 'POST',
      body: JSON.stringify({ action: 'saveAvatars', list }),
    })
  },

  async setAvatarDisplay(avatarId, settings) {
    const res = await fetchJson<{ avatar: AvatarState }>('/api/hermes/office', {
      method: 'POST',
      body: JSON.stringify({ action: settings ? 'setAvatarDisplay' : 'resetAvatarDisplay', avatarId, ...settings }),
    })
    if (!res.ok || !res.data?.avatar) throw new Error(res.error || 'Không thể lưu hiển thị')
    displayRevision++
    const avatar = res.data.avatar
    set((state) => ({ avatars: [...state.avatars.filter((a) => a.avatarId !== avatar.avatarId), avatar] }))
  },

  async refreshMeeting() {
    // A blip here must not clear the panel: keep the last known meeting and say
    // nothing, because this polls every few seconds and an error banner that
    // flickers on every dropped packet is worse than silence.
    const res = await fetchJson<{
      configured?: boolean
      live?: Meeting[]
      archived?: ArchivedMeeting[]
    }>('/api/hermes/meeting', { cache: 'no-store' })
    if (!res.ok || !res.data) return
    const d = res.data
    // `live` are meetings in this process; `archived` are the transcripts on disk
    // from this and earlier runs. The picker needs both.
    const list: Meeting[] = d.live || []
    // Only a live meeting may pin agents to the conference table. A finished or
    // failed one still belongs in the panel for its transcript, but the office
    // floor must let those avatars go.
    const active = list.find((m) => m.state === 'queued' || m.state === 'running') ?? null
    set({
      meeting: active ?? list[0] ?? null,
      meetingConfigured: !!d.configured,
      meetingHistory: d.archived || [],
    })
  },

  async loadBoards() {
    const res = await fetchJson<{ boards?: BoardInfo[]; defaultBoard?: string; writes?: { management?: boolean; privileged?: boolean } }>(
      '/api/hermes/boards',
      { cache: 'no-store' },
    )
    if (!res.ok || !res.data) {
      set({ boardsError: res.error || 'Không đọc được danh sách bảng' })
      return
    }
    const boards = res.data.boards || []
    const defaultBoard = res.data.defaultBoard || ''
    const w = res.data.writes || {}
    set({ boards, defaultBoard, boardsError: null, writes: { management: w.management === true, privileged: w.privileged === true } })
    // A stored/linked board that no longer exists falls back to the default instead of 404ing every poll.
    const cur = get().board
    if (cur && boards.length && !boards.some((b) => b.slug === cur)) get().setBoard('')
  },

  async archiveTasks(ids) {
    return cardWrite('archive', ids, set, get)
  },

  async deleteTasks(ids) {
    return cardWrite('delete', ids, set, get)
  },

  setKanbanNotice: (kanbanNotice) => set({ kanbanNotice }),

  setBoard(slug) {
    const board = slug && slug === get().defaultBoard ? '' : slug
    if (board === get().board) return
    setApiBoard(board)
    storeBoard(board)
    writeUrlParam('board', board || null)
    writeUrlParam('task', null)
    set({ board, tasks: [], openTaskId: null, loading: true })
    void get().load()
  },

  initFromUrl(opts = {}) {
    const u = readUrlState()
    const board = u.board ?? storedBoard() ?? ''
    setApiBoard(board)
    if (board) writeUrlParam('board', board)
    set({
      board,
      ...(opts.view && u.view ? { view: u.view } : {}),
      ...(u.task ? { openTaskId: u.task } : {}),
    })
  },

  setView: (view) => {
    writeUrlParam('view', view === '3d' ? null : urlView(view))
    set({ view })
  },
  setPeek: (peekDesk) => set({ peekDesk }),
  openTask: (openTaskId) => {
    writeUrlParam('task', openTaskId)
    set({ openTaskId })
  },
  select: (selectedAgent) => set({ selectedAgent }),
  setNewTaskOpen: (newTaskOpen) => set({ newTaskOpen }),
}))

/**
 * Poll the board; returns a stop function. `kanbanOnly` (the /kanban page) polls just the
 * tasks — no meeting/office/health/work reads, no 3D scene.
 */
export function startPolling(opts: { kanbanOnly?: boolean } = {}) {
  let stopped = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    if (stopped || running) return
    if (document.hidden) return schedule()
    running = true
    try {
      await Promise.all(opts.kanbanOnly ? [useOffice.getState().load()] : [
        useOffice.getState().load(),
        useOffice.getState().refreshMeeting(),
        useOffice.getState().loadOffice(),
        useOffice.getState().loadHealth(),
        useOffice.getState().loadWork(),
      ])
    } finally {
      running = false
      schedule()
    }
  }
  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, POLL_MS)
  }
  const onVisibility = () => {
    if (!document.hidden) {
      clearTimeout(timer)
      void tick()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)
  void tick()
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

/* ----------------------------------------------------- archive / delete -- */

export type ArchiveOutcome = { id: string; ok: boolean; code?: string; title?: string }
export type ArchiveResult = { ok: boolean; results: ArchiveOutcome[]; error: string | null }

/** Must match deleteConfirmToken() on the server. */
export function deleteConfirmToken(ids: string[]): string {
  return `delete:${[...ids].sort().join(',')}`
}

type SetFn = (p: Partial<State> | ((s: State) => Partial<State>)) => void

async function cardWrite(action: 'archive' | 'delete', ids: string[], set: SetFn, get: () => State): Promise<ArchiveResult> {
  const board = get().board
  const prev = get().tasks
  const target = new Set(ids)
  // Optimistic: move/remove now, reconcile with the server's per-id answer below.
  set({
    tasks:
      action === 'delete'
        ? prev.filter((t) => !target.has(t.id) || t.status === 'running')
        : prev.map((t) => (target.has(t.id) && t.status !== 'running' ? { ...t, status: 'archived' } : t)),
    kanbanNotice: null,
  })
  const res = await fetchJson<{ ok?: boolean; results?: ArchiveOutcome[] }>('/api/hermes/tasks/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action === 'delete' ? { action, ids, confirm: deleteConfirmToken(ids) } : { action, ids }),
  })
  const results = res.data?.results || []
  const done = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  if (get().board === board) {
    if (!res.ok && !results.length) set({ tasks: prev })
    void get().load()
    void get().loadBoards()
  }
  const list = failed.map((f) => `${f.title || f.id} (${codeText(f.code)})`).join('; ')
  const error = !res.ok && !results.length
    ? translate('Kanban.noticeFailed', { error: res.error || '' })
    : failed.length
      ? translate('Kanban.noticePartial', { done, failed: failed.length, list })
      : null
  const okText = action === 'delete' ? translate('Kanban.noticeDeleted', { count: done }) : translate('Kanban.noticeArchived', { count: done })
  set({ kanbanNotice: error ? { kind: 'err', text: error } : { kind: 'ok', text: okText } })
  return { ok: !error, results, error }
}

function codeText(code?: string): string {
  if (code === 'running') return translate('Kanban.codeRunning')
  if (code === 'not_found') return translate('Kanban.codeNotFound')
  if (code === 'already_archived') return translate('Kanban.codeAlready')
  if (code === 'refused') return translate('Kanban.codeRefused')
  return translate('Kanban.codeOther')
}
