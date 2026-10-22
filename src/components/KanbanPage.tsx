'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import KanbanColumns from './KanbanColumns'
import TaskPanel from './TaskPanel'
import { startPolling, useOffice } from '@/lib/store'
import { t as translate } from '@/lib/i18n'

/**
 * /kanban — the board on its own page. No Three.js, no office/meeting/health polling: only
 * the selected board's tasks (+ the all-board agent status the tasks route already returns).
 * ?board= and ?task= work the same as in the office, so a card link can be shared.
 */
export default function KanbanPage() {
  const initFromUrl = useOffice((s) => s.initFromUrl)
  const loadBoards = useOffice((s) => s.loadBoards)
  const board = useOffice((s) => s.board)
  const tasks = useOffice((s) => s.tasks)
  const error = useOffice((s) => s.error)

  useEffect(() => {
    initFromUrl()
    void loadBoards()
    const stop = startPolling({ kanbanOnly: true })
    const b = setInterval(() => void loadBoards(), 30_000)
    return () => {
      stop()
      clearInterval(b)
    }
  }, [initFromUrl, loadBoards])

  const running = tasks.filter((t) => t.status === 'running').length
  const back = `/?view=kanban${board ? `&board=${encodeURIComponent(board)}` : ''}`

  return (
    <div className="vp-kpage">
      <header className="vp-kpage-head">
        <img className="vp-logo-img" src="/oxmode-logo.png" alt="OXMODE" width={126} height={18} />
        <h1>{translate('Kanban.pageTitle')}</h1>
        <span className="vp-muted vp-kpage-stat">
          {error ? <span className="vp-err">{error}</span> : translate('Kanban.pageStat', { total: tasks.filter((t) => t.status !== 'archived').length, running })}
        </span>
        <Link className="vp-chip-btn vp-kpage-back" href={back} title={translate('Kanban.backToOffice')}>
          ⤡ {translate('Kanban.backToOffice')}
        </Link>
      </header>
      <main className="vp-kpage-body vp-k2d">
        <KanbanColumns search freshness boards tabs manage />
      </main>
      <TaskPanel />
    </div>
  )
}
