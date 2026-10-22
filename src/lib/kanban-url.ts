'use client'

/**
 * Kanban state that lives in the URL so a reload (or a shared link) lands on the same thing:
 *   ?view=3d|kanban|sprite   office view mode (office page only)
 *   ?board=<slug>            Hermes board
 *   ?task=<id>               open card drawer
 * Written with history.replaceState: switching boards or opening a card must not fill the
 * back button with entries.
 */
export const BOARD_KEY = 'hvo.kanban.board'

export type UrlView = '3d' | '2d' | 'sprite'

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TASK = /^t_[0-9a-zA-Z]{4,40}$/

export function readUrlState(): { board: string | null; view: UrlView | null; task: string | null } {
  if (typeof window === 'undefined') return { board: null, view: null, task: null }
  const q = new URLSearchParams(window.location.search)
  const b = q.get('board')
  const v = q.get('view')
  const t = q.get('task')
  return {
    board: b && SLUG.test(b) ? b : null,
    view: v === 'kanban' ? '2d' : v === '3d' || v === 'sprite' ? v : null,
    task: t && TASK.test(t) ? t : null,
  }
}

export function storedBoard(): string | null {
  try {
    const b = window.localStorage.getItem(BOARD_KEY)
    return b && SLUG.test(b) ? b : null
  } catch {
    return null
  }
}

export function storeBoard(board: string): void {
  try {
    if (board) window.localStorage.setItem(BOARD_KEY, board)
    else window.localStorage.removeItem(BOARD_KEY)
  } catch {
    // private mode: the URL still carries it
  }
}

export function writeUrlParam(key: 'board' | 'view' | 'task', value: string | null): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (value) url.searchParams.set(key, value)
  else url.searchParams.delete(key)
  const next = `${url.pathname}${url.search}${url.hash}`
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, '', next)
  }
}

export function urlView(view: UrlView): string {
  return view === '2d' ? 'kanban' : view
}
