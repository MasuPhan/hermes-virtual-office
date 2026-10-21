'use client'

import { useEffect, useState } from 'react'
import { useOffice } from '@/lib/store'
import type { AvatarDisplay } from '@/lib/office/types'
import { UI_DIVISION_LABEL as DIVISION_LABEL } from './UiLabels'
import type { AgentDivision } from '@/types/hermes'

/** Mounted for every roster row, independently of office membership or scene. */
export default function AvatarPanel({ avatarId, name }: { avatarId: string; name: string }) {
  const avatar = useOffice((s) => s.avatars.find((a) => a.avatarId === avatarId))
  return <details><summary>Hiển thị trong văn phòng · {name}</summary>
    <DisplayForm key={avatarId} avatarId={avatarId} name={name} settings={avatar} />
  </details>
}

function DisplayForm({ avatarId, name, settings }: { avatarId: string; name: string; settings?: AvatarDisplay }) {
  const save = useOffice((s) => s.setAvatarDisplay)
  const [displayName, setDisplayName] = useState(settings?.displayName ?? '')
  const [roleLabel, setRoleLabel] = useState(settings?.roleLabel ?? '')
  const [divisionOverride, setDivision] = useState(settings?.divisionOverride ?? '')
  const [useHermesDivision, setUseHermes] = useState(settings?.useHermesDivision !== false)
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  // Refresh pristine forms when office polling finishes; never replace a draft.
  useEffect(() => {
    if (dirty || busy) return
    setDisplayName(settings?.displayName ?? '')
    setRoleLabel(settings?.roleLabel ?? '')
    setDivision(settings?.divisionOverride ?? '')
    setUseHermes(settings?.useHermesDivision !== false)
  }, [settings, dirty, busy])
  async function submit(reset: boolean) {
    setBusy(reset ? 'reset' : 'save'); setError(''); setSaved(false)
    try {
      await save(avatarId, reset ? null : {
        displayName, roleLabel, useHermesDivision,
        divisionOverride: divisionOverride ? divisionOverride as AgentDivision : undefined,
      })
      if (reset) { setDisplayName(''); setRoleLabel(''); setDivision(''); setUseHermes(true) }
      setDirty(false); setSaved(true)
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(null) }
  }
  return <form className="vp-pad flex flex-col gap-3" onChange={() => { setDirty(true); setSaved(false) }} onSubmit={(e) => { e.preventDefault(); void submit(false) }}>
    <p>Hiển thị trong văn phòng · {name}</p>
    <fieldset disabled={!!busy} className="flex flex-col gap-3">
      <label>Tên hiển thị<input className="vp-input" value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} /></label>
      <label>Vai trò hiển thị<input className="vp-input" value={roleLabel} maxLength={80} onChange={(e) => setRoleLabel(e.target.value)} /></label>
      <label><input type="checkbox" checked={useHermesDivision} onChange={(e) => setUseHermes(e.target.checked)} /> Dùng phòng ban Hermes</label>
      <label>Phòng ban văn phòng<select className="vp-input" disabled={useHermesDivision} value={divisionOverride} onChange={(e) => setDivision(e.target.value)}>
        <option value="">Theo Hermes</option>
        {(['exec', 'tech', 'growth', 'content'] as const).map((d) => <option key={d} value={d}>{DIVISION_LABEL[d]}</option>)}
      </select></label>
      <button className="vp-btn" type="submit">{busy === 'save' ? 'Đang lưu…' : 'Lưu'}</button>
      <button className="vp-btn vp-btn-ghost" type="button" onClick={() => void submit(true)}>{busy === 'reset' ? 'Đang khôi phục…' : 'Khôi phục mặc định Hermes'}</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">Đã lưu</p>}
  </form>
}
