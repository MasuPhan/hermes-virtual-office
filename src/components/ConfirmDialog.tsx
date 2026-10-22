'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { t as translate } from '@/lib/i18n'

/**
 * Small confirm modal for archive/delete. Esc / backdrop cancel; focus starts on Cancel.
 * Portalled to <body>: the drawer has backdrop-filter, which makes it the containing block
 * of any position:fixed child — rendered inside it, the dialog was clipped to the drawer.
 */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="vp-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className={`vp-modal vp-confirm${danger ? ' vp-confirm-danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{title}</h3>
        <p className="vp-confirm-body">{body}</p>
        <div className="vp-modal-actions">
          <button ref={cancelRef} className="vp-btn" onClick={onCancel} disabled={busy}>
            {translate('Kanban.cancel')}
          </button>
          <button className={`vp-btn ${danger ? 'vp-btn-warn' : 'primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? translate('Kanban.working') : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
