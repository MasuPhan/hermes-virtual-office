'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { UI_ORIGIN_LABEL, uiState } from './UiLabels'
import { useOffice } from '@/lib/store'
import { t as translate } from '@/lib/i18n'
import BoardSwitcher from './BoardSwitcher'
import { EVIDENCE_MARK_LABEL, STALE_EVIDENCE, markClass, markOf, useEvidenceMarks } from './useEvidenceMarks'
import {
  STALE_VERIFICATION,
  VERIFICATION_MARK_LABEL,
  verificationMarkClass,
  verificationMarkOf,
  useVerificationMarks,
} from './useVerificationMarks'

/**
 * SATU-SATUNYA perender kolom kanban: view "Kanban", trang /kanban toàn màn hình, papan
 * dinding 3D (KanbanModal), dan panel Papan semuanya memakai ini. Yang boleh beda antar
 * tempat hanya bingkainya (lewat props), bukan isi kolom/kartunya.
 *
 * Tràn thẻ (audit A1): mọi ô con của thẻ phải co được — tiêu đề bẻ dòng ở bất kỳ ký tự
 * nào (URL dài), chip một dòng + dấu "…" kèm tooltip đầy đủ, mã thẻ ở dòng riêng.
 * Cột trống thu thành một dải hẹp để cột có việc được rộng ra.
 */

type ColumnDef = { id: string; label: string; statuses: string[] }

export const KANBAN_COLUMNS: ColumnDef[] = [
  { id: 'todo', label: translate('KanbanColumns.text1'), statuses: ['todo', 'triage', 'ready', 'scheduled'] },
  { id: 'running', label: translate('KanbanColumns.text2'), statuses: ['running'] },
  { id: 'review', label: translate('KanbanColumns.text3'), statuses: ['review'] },
  { id: 'done', label: translate('KanbanColumns.text4'), statuses: ['done'] },
  { id: 'blocked', label: translate('KanbanColumns.text5'), statuses: ['blocked'] },
  { id: 'archived', label: translate('KanbanColumns.text6'), statuses: ['archived'] },
]
const KNOWN = KANBAN_COLUMNS.flatMap((column) => column.statuses)

const COL_W = 200
const RAIL_W = 52
const GAP = 12

export default function KanbanColumns({
  search = false,
  freshness = false,
  boards = false,
  fullscreenLink = false,
  tabs = false,
  closeAfterOpen,
}: {
  /** Kotak cari judul/assignee di atas kolom. */
  search?: boolean
  /** Catatan umur penanda bukti/verifikasi + "BASI". */
  freshness?: boolean
  /** Bộ chọn bảng Hermes trên thanh công cụ. */
  boards?: boolean
  /** Nút mở /kanban toàn màn hình (từ chế độ xem Kanban trong văn phòng). */
  fullscreenLink?: boolean
  /** Thanh tab cột trên điện thoại (chỉ hiện ≤720px). */
  tabs?: boolean
  /**
   * Dipanggil setelah `openTask`. Wadah yang menutupi panel detail (modal, panel layar
   * penuh) harus menutup diri, kalau tidak klik kartu terlihat seperti tidak terjadi apa-apa.
   */
  closeAfterOpen?: () => void
}) {
  const tasks = useOffice((s) => s.tasks)
  const loading = useOffice((s) => s.loading)
  const openTaskId = useOffice((s) => s.openTaskId)
  const openTask = useOffice((s) => s.openTask)
  const [q, setQ] = useState('')
  const [showEmpty, setShowEmpty] = useState(false)
  // Penanda dibaca dari SEMUA task, bukan hasil cari: mengetik di kotak cari tidak boleh
  // memicu batch baca bukti baru.
  const marks = useEvidenceMarks(tasks)
  // Klaim ≠ terverifikasi: penanda review independen, hanya untuk done/review.
  const vf = useVerificationMarks(tasks)

  const needle = search ? q.trim().toLowerCase() : ''
  const shown = needle
    ? tasks.filter((t) => t.title.toLowerCase().includes(needle) || (t.assignee ?? '').toLowerCase().includes(needle))
    : tasks
  const all = [
    ...KANBAN_COLUMNS.map((column) => ({ ...column, other: false, items: shown.filter((task) => column.statuses.includes(task.status)) })),
    {
      id: 'other',
      label: translate('KanbanColumns.text7'),
      statuses: [] as string[],
      other: true,
      items: shown.filter((task) => !KNOWN.includes(task.status)),
    },
  ]
  // "Trạng thái khác" chỉ có mặt khi thật sự có thẻ lạ; các cột trống còn lại thu thành dải.
  const columns = all
    .filter((c) => !c.other || c.items.length)
    .map((c) => ({ ...c, collapsed: !showEmpty && !c.items.length }))
  const emptyCount = columns.filter((c) => !c.items.length).length
  const open = columns.filter((c) => !c.collapsed).length
  const rails = columns.length - open
  const gridStyle = {
    '--vp-cols': columns.map((c) => (c.collapsed ? `${RAIL_W}px` : `minmax(${COL_W}px, 1fr)`)).join(' '),
    '--vp-minw': `${open * COL_W + rails * RAIL_W + (columns.length - 1) * GAP}px`,
  } as CSSProperties

  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const colRefs = useRef<Record<string, HTMLElement | null>>({})
  const [active, setActive] = useState<string>('todo')
  const colKey = columns.map((c) => c.id).join(',')
  useEffect(() => {
    if (!tabs || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const best = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        const id = best?.target.getAttribute('data-col')
        if (id) setActive(id)
      },
      { threshold: [0.55, 0.8] },
    )
    for (const el of Object.values(colRefs.current)) if (el) io.observe(el)
    return () => io.disconnect()
  }, [tabs, colKey])

  const showTools = search || freshness || boards || fullscreenLink || emptyCount > 0
  return (
    <>
      {showTools && (
        <KanbanToolbar
          {...{ search, freshness, boards, fullscreenLink, q, setQ, marks, vf }}
          emptyCount={emptyCount}
          showEmpty={showEmpty}
          setShowEmpty={setShowEmpty}
        />
      )}
      {tabs && (
        <nav className="vp-col-tabs" aria-label={translate('Kanban.columnTabs')}>
          {columns.map((c) => (
            <button
              key={c.id}
              type="button"
              className={active === c.id ? 'on' : ''}
              aria-current={active === c.id ? 'true' : undefined}
              onClick={() => {
                setActive(c.id)
                colRefs.current[c.id]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
              }}
            >
              <span>{c.label}</span>
              <b>{c.items.length}</b>
            </button>
          ))}
        </nav>
      )}
      {!loading && !tasks.length && <div className="vp-k2d-empty vp-muted">{translate('Kanban.emptyBoard')}</div>}
      <div className="vp-k2d-grid grid gap-3" style={gridStyle}>
        {columns.map((column) => (
          <section
            key={column.id}
            id={`vp-col-${uid}-${column.id}`}
            data-col={column.id}
            ref={(el) => {
              colRefs.current[column.id] = el
            }}
            className={`vp-col${column.collapsed ? ' vp-col-collapsed' : ''}`}
            title={column.collapsed ? translate('Kanban.collapsedTitle', { label: column.label }) : undefined}
            onClick={column.collapsed ? () => setShowEmpty(true) : undefined}
          >
            <header className="vp-col-head">
              <span className="vp-col-label">{column.label}</span>
              <span className="vp-count">{column.items.length}</span>
            </header>
            <div className="vp-col-body flex flex-col gap-2">
              {column.items.map((task) => {
                const mark = markOf(marks, task)
                const vmark = verificationMarkOf(vf, task)
                const who = column.other ? uiState(task.status) : task.assignee || '—'
                const originLabel = task.origin && task.origin.kind !== 'manual' ? UI_ORIGIN_LABEL[task.origin.kind] ?? task.origin.kind : null
                const pick = () => {
                  openTask(task.id)
                  closeAfterOpen?.()
                }
                return (
                  <article
                    key={task.id}
                    className={`vp-card${openTaskId === task.id ? ' on' : ''}`}
                    role="button"
                    tabIndex={0}
                    title={task.title}
                    onClick={pick}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        pick()
                      }
                    }}
                  >
                    <div className="vp-card-title">{task.title}</div>
                    <div className="vp-card-meta">
                      <span className="vp-chip vp-chip-who" title={who}>{who}</span>
                      {originLabel && task.origin && (
                        <span className={`vp-chip vp-chip-${task.origin.kind}`} title={originLabel}>{originLabel}</span>
                      )}
                      {mark && (
                        <span className={markClass(mark)} title={EVIDENCE_MARK_LABEL[mark]}>{EVIDENCE_MARK_LABEL[mark]}</span>
                      )}
                      {vmark && (
                        <span className={verificationMarkClass(vmark)} title={VERIFICATION_MARK_LABEL[vmark]}>
                          {VERIFICATION_MARK_LABEL[vmark]}
                        </span>
                      )}
                    </div>
                    <code className="vp-card-id">{task.id}</code>
                  </article>
                )
              })}
              {!column.items.length && <div className="vp-empty">{translate('KanbanColumns.text8')}</div>}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}

function KanbanToolbar({
  search,
  freshness,
  boards,
  fullscreenLink,
  q,
  setQ,
  marks,
  vf,
  emptyCount,
  showEmpty,
  setShowEmpty,
}: {
  search: boolean
  freshness: boolean
  boards: boolean
  fullscreenLink: boolean
  q: string
  setQ: (q: string) => void
  marks: ReturnType<typeof useEvidenceMarks>
  vf: ReturnType<typeof useVerificationMarks>
  emptyCount: number
  showEmpty: boolean
  setShowEmpty: (v: boolean) => void
}) {
  const board = useOffice((s) => s.board)
  const marksAge = marks.readAt ? Math.round((Date.now() - marks.readAt) / 1000) : null
  const vfAge = vf.readAt ? Math.round((Date.now() - vf.readAt) / 1000) : null
  return (
    // sticky-left: di HP grid digeser ke samping, kotak cari dan catatan tetap di layar.
    <div className="vp-kanban-tools">
      {boards && <BoardSwitcher />}
      {freshness && (
        <div className="vp-kanban-fresh">
          <p className="vp-sub">
            {marks.error ? (
              <span className="vp-err">{translate('KanbanColumns.text9')}{marks.error}</span>
            ) : marksAge == null ? (
              marks.busy ? translate('KanbanColumns.text10') : translate('KanbanColumns.text11')
            ) : (
              <>
                {translate('KanbanColumns.text12')}{marksAge}{translate('KanbanColumns.text13')}
                {marksAge > STALE_EVIDENCE && <span className="vp-warn">{translate('KanbanColumns.text14')}</span>}
              </>
            )}
          </p>
          <p className="vp-sub">
            {vf.error ? (
              <span className="vp-err">{translate('KanbanColumns.text15')}{vf.error}</span>
            ) : vfAge == null ? (
              vf.busy ? translate('KanbanColumns.text16') : translate('KanbanColumns.text17')
            ) : (
              <>
                {translate('KanbanColumns.text18')}{vfAge}{translate('KanbanColumns.text19')}
                {vfAge > STALE_VERIFICATION && <span className="vp-warn">{translate('KanbanColumns.text20')}</span>}
              </>
            )}
          </p>
        </div>
      )}
      <div className="vp-kanban-actions">
        {search && (
          <input
            className="vp-kanban-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={translate('KanbanColumns.text21')}
          />
        )}
        {emptyCount > 0 && (
          <button type="button" className="vp-chip-btn" onClick={() => setShowEmpty(!showEmpty)}>
            {showEmpty ? translate('Kanban.hideEmpty') : translate('Kanban.showEmpty', { count: emptyCount })}
          </button>
        )}
        {fullscreenLink && (
          <Link
            className="vp-chip-btn vp-kanban-max"
            href={board ? `/kanban?board=${encodeURIComponent(board)}` : '/kanban'}
            title={translate('Kanban.fullscreenTitle')}
          >
            ⤢ {translate('Kanban.fullscreen')}
          </Link>
        )}
      </div>
    </div>
  )
}
