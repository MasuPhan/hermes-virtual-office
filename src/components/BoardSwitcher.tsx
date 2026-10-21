'use client'

import { useEffect, useRef, useState } from 'react'
import { useOffice, type BoardInfo } from '@/lib/store'
import { t as translate } from '@/lib/i18n'

/**
 * Which Hermes board the Kanban shows. Purely a view choice: it changes `?board=` on our
 * own API calls (URL + localStorage), and never runs `hermes kanban boards switch`, which
 * would move the CLI's current board for every other Hermes client too.
 */
export default function BoardSwitcher() {
  const board = useOffice((s) => s.board)
  const boards = useOffice((s) => s.boards)
  const defaultBoard = useOffice((s) => s.defaultBoard)
  const boardsError = useOffice((s) => s.boardsError)
  const setBoard = useOffice((s) => s.setBoard)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const slug = board || defaultBoard
  const current = boards.find((b) => b.slug === slug)
  const name = current ? current.name : slug || translate('Kanban.boardDefault')

  return (
    <div className="vp-board-switch" ref={ref}>
      <button
        type="button"
        className="vp-board-switch-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={translate('Kanban.boardSwitch')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="vp-board-dot" style={dotStyle(current?.color)} />
        <span className="vp-board-name">{current?.icon ? `${current.icon} ` : ''}{name}</span>
        {current && <span className="vp-count">{current.total}</span>}
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="vp-board-menu" role="listbox" aria-label={translate('Kanban.boardSwitch')}>
          {boardsError && <div className="vp-err vp-board-menu-note">{translate('Kanban.boardsUnavailable')}</div>}
          {!boardsError && !boards.length && <div className="vp-muted vp-board-menu-note">{translate('Kanban.loading')}</div>}
          {boards.map((b) => (
            <BoardRow
              key={b.slug}
              b={b}
              on={b.slug === slug}
              isDefault={b.slug === defaultBoard}
              pick={() => {
                setBoard(b.slug)
                setOpen(false)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function BoardRow({ b, on, isDefault, pick }: { b: BoardInfo; on: boolean; isDefault: boolean; pick: () => void }) {
  const c = b.counts || {}
  const busy = (c.running || 0) + (c.review || 0)
  const blocked = c.blocked || 0
  return (
    <button type="button" role="option" aria-selected={on} className={`vp-board-opt${on ? ' on' : ''}`} onClick={pick}>
      <span className="vp-board-dot" style={dotStyle(b.color)} />
      <span className="vp-board-opt-main">
        <span className="vp-board-name">{b.icon ? `${b.icon} ` : ''}{b.name}</span>
        <span className="vp-board-opt-sub">
          {b.slug}
          {isDefault ? ` · ${translate('Kanban.boardDefault')}` : ''}
          {busy ? ` · ${translate('Kanban.boardBusy', { count: busy })}` : ''}
          {blocked ? ` · ${translate('Kanban.boardBlocked', { count: blocked })}` : ''}
        </span>
      </span>
      <span className="vp-count" title={translate('Kanban.boardTasks', { count: b.total })}>{b.total}</span>
    </button>
  )
}

/** Board colours come from the Hermes CLI; only plain hex/rgb values reach the style. */
function dotStyle(color?: string) {
  return color && /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/.test(color) ? { background: color } : undefined
}
