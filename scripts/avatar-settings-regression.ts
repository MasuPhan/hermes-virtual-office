/** Isolated runtime regression. Never invokes the real Hermes executable. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { DatabaseSync } from 'node:sqlite'
import { NextRequest } from 'next/server'

async function main() {
const root = mkdtempSync('/private/tmp/hvo-avatar-')
process.env.OFFICE_DB_PATH = join(root, 'office.db')
process.env.HVO_HERMES_ROOT = join(root, 'fleet')
process.env.HERMES_HOME = process.env.HVO_HERMES_ROOT
process.env.HERMES_BIN = join(root, 'fixture-hermes')
process.env.HVO_MANAGEMENT_MODE = 'safe'
writeFileSync(process.env.HERMES_BIN, `#!/bin/sh\ncase "$*" in *assignees*) printf '[{"name":"orphan","on_disk":false,"counts":{"done":1}}]' ;; *) printf "[]" ;; esac\n`, { mode: 0o700 })
for (const name of ['alpha', 'hidden', 'resetonly']) {
  mkdirSync(join(process.env.HVO_HERMES_ROOT!, 'profiles', name), { recursive: true })
  writeFileSync(join(process.env.HVO_HERMES_ROOT!, 'profiles', name, 'config.yaml'), '# isolated fixture\n')
}
// Simulate a pre-settings database: migration must add settings in place.
const legacy = new DatabaseSync(process.env.OFFICE_DB_PATH)
legacy.exec(`CREATE TABLE avatar_state (avatar_id TEXT PRIMARY KEY, name TEXT NOT NULL,
 division TEXT NOT NULL, kind TEXT NOT NULL, x REAL NOT NULL, z REAL NOT NULL,
 level INTEGER NOT NULL DEFAULT 0, activity TEXT NOT NULL, facing REAL NOT NULL DEFAULT 0,
 spawned INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`)
legacy.close()
const db = await import('../src/lib/office/db')
const { POST, GET } = await import('../src/app/api/hermes/office/route')
const { useOffice } = await import('../src/lib/store')
const { officeAgents, officeSeats, sceneRows } = await import('../src/lib/office/presentation')
const { officeDivision } = await import('../src/lib/office/types')
const { DESKS, meetingRoomFor } = await import('../src/lib/office/layout')
const { hide, isHidden, show } = await import('../src/lib/hermes/office-membership')
const request = (body: unknown, origin = 'http://localhost:3001') => new NextRequest('http://localhost:3001/api/hermes/office', {
  method: 'POST', headers: { host: 'localhost:3001', origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
})
let posts = 0
let failSave = false
const roster = [{ name: 'alpha', profile: true, inOffice: true, total: 1, division: 'tech' },
  { name: 'hidden', profile: true, inOffice: false, reason: 'hidden', total: 0, division: 'content' }]
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url === '/api/hermes/office') {
    if (init?.method === 'POST') {
      posts++
      if (failSave) return Response.json({ error: { message: 'fixture save error' } }, { status: 500 })
      return POST(request(JSON.parse(String(init.body))))
    }
    return GET(new NextRequest('http://localhost:3001/api/hermes/office', { headers: { host: 'localhost:3001' } }))
  }
  if (url === '/api/hermes/agents') return Response.json({ available: roster })
  return Response.json({})
}
try {
  assert.equal((await POST(request({ action: 'setAvatarDisplay', avatarId: 'agent:alpha' }, 'https://evil.invalid'))).status, 403)
  for (const bad of [{ avatarId: 'agent:../oops' }, { avatarId: 'agent:alpha', divisionOverride: 'bad' },
    { avatarId: 'agent:alpha', displayName: 3 }, { avatarId: 'agent:alpha', useHermesDivision: 'false' },
    { avatarId: 'agent:alpha', roleLabel: 'x'.repeat(81) }]) {
    assert.equal((await POST(request({ action: 'setAvatarDisplay', ...bad }))).status, 400)
  }
  assert.deepEqual(db.listAvatars(), [])
  assert.equal((await POST(request({ action: 'setAvatarDisplay', avatarId: 'agent:alpha', name: '../bad', kind: 'dummy', x: 999, spawned: true }))).status, 200)
  const safeSeed = db.listAvatars()[0]
  assert.equal(safeSeed.name, 'alpha'); assert.equal(safeSeed.kind, 'agent'); assert.equal(safeSeed.spawned, false); assert.notEqual(safeSeed.x, 999)
  db.deleteAvatar('agent:alpha')
  assert.equal((await POST(request({ action: 'setAvatarDisplay', avatarId: 'agent:unknown' }))).status, 404)
  hide('hidden')
  const { GET: rosterGET } = await import('../src/app/api/hermes/agents/route')
  const rosterReply = await rosterGET(new NextRequest('http://localhost:3001/api/hermes/agents', { headers: { host: 'localhost:3001' } }))
  assert.equal(rosterReply.status, 200)
  const actualRoster = (await rosterReply.json()).available
  assert(actualRoster.some((r: any) => r.name === 'hidden' && !r.inOffice && r.reason === 'hidden'), 'actual roster API includes runtime-hidden profiles')
  await useOffice.getState().setAvatarDisplay('agent:hidden', { displayName: 'Tên riêng', roleLabel: 'Thiết kế', divisionOverride: 'growth', useHermesDivision: false })
  assert.equal(isHidden('hidden'), true, 'saving settings must not change membership')
  assert.equal(useOffice.getState().avatars.length, 1, 'store inserts absent row')
  const saved = db.listAvatars()[0]
  assert.equal((await POST(request({ action: 'setAvatarDisplay', avatarId: 'agent:orphan', displayName: 'Cũ' }))).status, 200, 'task-only roster identity may save settings without creating a profile')
  assert.equal(db.listAvatars().find((a) => a.name === 'orphan')!.spawned, false)
  db.deleteAvatar('agent:orphan')
  assert.equal(saved.name, 'hidden'); assert.equal(saved.kind, 'agent'); assert.equal(saved.spawned, false)
  assert.deepEqual(sceneRows([saved], []), [], 'settings row cannot produce an absent agent body')
  db.saveAvatars([{ ...saved, displayName: 'stale', divisionOverride: 'tech', x: 12, spawned: true }])
  assert.equal(db.listAvatars()[0].displayName, 'Tên riêng')
  db._resetOfficeDbForTest()
  assert.equal(db.listAvatars()[0].divisionOverride, 'growth', 'settings survive reopen')
  await useOffice.getState().loadOffice()
  assert.equal(useOffice.getState().avatars[0].displayName, 'Tên riêng')
  const agent = { name: 'hidden', displayName: 'Hidden', role: 'backend', division: 'tech', deskIndex: DESKS.find((d) => d.division === 'tech')!.index, status: 'idle', currentTaskId: 'immutable-task' } as const
  const presented = officeAgents([agent], db.listAvatars())[0]
  assert.equal(presented.name, agent.name); assert.equal(presented.role, agent.role); assert.equal(presented.currentTaskId, agent.currentTaskId)
  assert.equal(presented.division, 'growth'); assert.equal(presented.displayName, 'Tên riêng')
  const seat = officeSeats([agent], db.listAvatars()).get(agent.name)
  assert.notEqual(seat, undefined, 'override receives a free desk in target division')
  if (seat !== undefined) assert.equal(DESKS.find((d) => d.index === seat)!.division, 'growth')
  assert.equal(meetingRoomFor(['hidden'], new Map([['hidden', presented.division!]])), 'semeru')
  await useOffice.getState().setAvatarDisplay('agent:hidden', null)
  db.saveAvatars([saved])
  assert.equal(db.listAvatars()[0].displayName, undefined, 'stale flush cannot undo reset')
  assert.equal(officeDivision(db.listAvatars()[0], 'tech'), 'tech')
  assert.equal(meetingRoomFor(['hidden'], new Map([['hidden', officeDivision(db.listAvatars()[0], 'tech')]])), 'bromo')
  assert.equal(officeSeats([agent], db.listAvatars()).get('hidden'), agent.deskIndex)
  const forbiddenSeat = officeSeats([agent], [{ ...saved, divisionOverride: 'exec' }]).get('hidden')
  if (forbiddenSeat !== undefined) assert.equal(DESKS.find((d) => d.index === forbiddenSeat)!.level, 0, 'role label never grants CEO room access')
  assert.equal((await POST(request({ action: 'resetAvatarDisplay', avatarId: 'agent:resetonly' }))).status, 200)
  assert.equal(db.listAvatars().find((a) => a.name === 'resetonly')!.useHermesDivision, true)
  assert.throws(() => db.setAvatarDisplay('agent:../bad', {}, '../bad'))

  const realFetch = globalThis.fetch
  const staleAvatars = db.listAvatars()
  let release!: (r: Response) => void
  globalThis.fetch = async (input, init) => String(input) === '/api/hermes/office' && !init?.method
    ? new Promise<Response>((r) => { release = r }) : realFetch(input, init)
  const oldPoll = useOffice.getState().loadOffice()
  await useOffice.getState().setAvatarDisplay('agent:hidden', { displayName: 'Mới', useHermesDivision: true })
  release(Response.json({ avatars: staleAvatars }))
  await oldPoll
  assert.equal(useOffice.getState().avatars.find((a) => a.name === 'hidden')!.displayName, 'Mới', 'in-flight stale poll cannot replace successful save')
  globalThis.fetch = realFetch

  // Run the actual TSX functions through a tiny deterministic hook host. This
  // executes event handlers/effects without introducing a DOM test dependency.
  // It is component runtime proof, not a browser/layout/accessibility test.
  const req = createRequire(import.meta.url)
  const stub = (props: any) => props.children ?? null
  function host(file: string, overrides: Record<string, any> = {}, effects = true, component = 'default') {
    let cursor = 0
    const cells: any[] = [], deps: any[] = []
    let pending: (() => void)[] = []
    const hooks = {
      useState(initial: any) { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial; return [cells[i], (v: any) => { cells[i] = typeof v === 'function' ? v(cells[i]) : v }] },
      useRef(initial: any) { const i = cursor++; return cells[i] ??= { current: initial } },
      useEffect(fn: any, values?: any[]) { const i = cursor++; if (effects && (!deps[i] || !values || values.some((v, n) => v !== deps[i][n]))) pending.push(fn); deps[i] = values },
    }
    const mod = { exports: {} as any }
    const js = ts.transpileModule(readFileSync(resolve(file), 'utf8') + (component === 'default' ? '' : `\nexport { ${component} };`), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
    const load = (id: string): any => {
      if (id in overrides) return overrides[id]
      if (id === 'react') return hooks
      if (id === '@/lib/store') return { useOffice: (select: any) => select(useOffice.getState()), startPolling: () => () => {} }
      if (id === '@/lib/api') return req('../src/lib/api')
      if (id === '@/lib/office/types') return req('../src/lib/office/types')
      if (id === './UiLabels') return req('../src/components/UiLabels')
      if (id.startsWith('./') || id === 'next/dynamic') return { __esModule: true, default: stub }
      return req(id)
    }
    vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { console })(load, mod, mod.exports)
    return { render(props: any) { cursor = 0; pending = []; const tree = (component === 'default' ? mod.exports.default : mod.exports[component])(props); for (const fn of pending) fn(); return tree } }
  }
  function nodes(tree: any): any[] {
    if (tree == null || typeof tree === 'boolean') return []
    if (Array.isArray(tree)) return tree.flatMap(nodes)
    if (typeof tree !== 'object') return [tree]
    return [tree, ...nodes(tree.props?.children)]
  }
  const text = (tree: any) => nodes(tree).filter((x) => typeof x === 'string' || typeof x === 'number').join(' ')
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const Avatar = host('src/components/AvatarPanel.tsx')
  const agentPanelToken = () => null
  const app = host('src/components/OfficeApp.tsx', { './AgentSpawnPanel': { __esModule: true, default: agentPanelToken } }, false)
  for (const view of ['3d', '2d', 'sprite'] as const) {
    useOffice.setState({ view })
    let tree = app.render({})
    nodes(tree).find((n) => n.type === 'button' && text(n).startsWith('Tác tử (')).props.onClick()
    tree = app.render({})
    assert(nodes(tree).some((n) => n.type === agentPanelToken && n.props?.open === true && typeof n.props?.onChanged === 'function'), `agent panel reachable in ${view}`)
  }
  const token = () => null
  const panel = host('src/components/AgentSpawnPanel.tsx', { './AvatarPanel': { __esModule: true, default: token } })
  const panelProps = { open: true, onClose() {}, onChanged() {} }
  panel.render(panelProps); await tick(); await tick()
  const forms = nodes(panel.render(panelProps)).filter((n) => n.type === token)
  assert.deepEqual(forms.map((n) => n.props.avatarId), ['agent:alpha', 'agent:hidden'])
  useOffice.setState({ avatars: [...useOffice.getState().avatars.filter((a) => a.name !== 'hidden'), { ...saved, divisionOverride: 'growth' }] })
  let panelTree = panel.render(panelProps)
  nodes(panelTree).find((n) => n.type === 'select' && n.props.title === 'Lọc danh sách tác tử theo bộ phận').props.onChange({ target: { value: 'growth' } })
  panelTree = panel.render(panelProps)
  assert.deepEqual(nodes(panelTree).filter((n) => n.type === token).map((n) => n.props.name), ['hidden'], 'panel groups by office override')
  nodes(panelTree).find((n) => n.type === 'select' && n.props.title === 'Lọc danh sách tác tử theo bộ phận').props.onChange({ target: { value: 'all' } })
  assert(forms.every((n) => n.props.name === n.props.avatarId.slice(6)), 'canonical names passed visibly')
  let tree = Avatar.render({ avatarId: 'agent:alpha', name: 'alpha' })
  assert(text(tree).includes('alpha'))
  // DisplayForm is a real nested function component; host its own hooks by
  // exposing it from the transpiled module, retaining the same production body.
  const form = host('src/components/AvatarPanel.tsx', {}, true, 'DisplayForm')
  const props = () => ({ avatarId: 'agent:alpha', name: 'alpha', settings: useOffice.getState().avatars.find((a) => a.name === 'alpha') })
  tree = form.render(props())
  const before = posts
  nodes(tree).find((n) => n.type === 'input' && n.props.maxLength === 80).props.onChange({ target: { value: 'Bản nháp' } })
  tree.props.onChange()
  await useOffice.getState().loadOffice()
  tree = form.render(props())
  assert.equal(nodes(tree).find((n) => n.type === 'input' && n.props.maxLength === 80).props.value, 'Bản nháp')
  assert.equal(posts, before, 'typing and polling do not write')
  const other = host('src/components/AvatarPanel.tsx', {}, true, 'DisplayForm')
  const otherTree = other.render({ avatarId: 'agent:hidden', name: 'hidden', settings: saved })
  assert.equal(nodes(otherTree).find((n) => n.type === 'input' && n.props.maxLength === 80).props.value, 'Tên riêng')
  assert.equal(nodes(form.render(props())).find((n) => n.type === 'input' && n.props.maxLength === 80).props.value, 'Bản nháp', 'switching preserves per-agent draft')
  tree.props.onSubmit({ preventDefault() {} })
  assert(text(form.render(props())).includes('Đang lưu…'))
  await tick(); await tick()
  tree = form.render(props())
  assert(text(tree).includes('Đã lưu'))
  assert.equal(db.listAvatars().find((a) => a.name === 'alpha')!.displayName, 'Bản nháp')
  assert.equal(useOffice.getState().avatars.filter((a) => a.name === 'alpha').length, 1)
  failSave = true
  nodes(tree).find((n) => n.type === 'button' && n.props.type === 'button').props.onClick()
  await tick(); await tick()
  tree = form.render(props())
  assert(nodes(tree).some((n) => n.props?.role === 'alert' && text(n).includes('fixture save error')))
  assert.equal(nodes(tree).find((n) => n.type === 'input' && n.props.maxLength === 80).props.value, 'Bản nháp')
  failSave = false
  nodes(tree).find((n) => n.type === 'button' && n.props.type === 'button').props.onClick()
  assert(text(form.render(props())).includes('Đang khôi phục…'))
  await tick(); await tick()
  tree = form.render(props()); tree = form.render(props())
  assert.equal(nodes(tree).find((n) => n.type === 'input' && n.props.maxLength === 80).props.value, '')
  assert(text(tree).includes('alpha'), 'reset preserves canonical profile identity')
  assert.equal(db.listAvatars().find((a) => a.name === 'alpha')!.displayName, undefined)
  console.log('PASS avatar settings: API guards, absent-row save/reset, store insert/update, reopen, stale flush, routing/seats/reset, all-view reachability, outside-row form, draft/poll/switch/save/error/reset')
} finally {
  show('hidden')
  db._resetOfficeDbForTest()
  rmSync(root, { recursive: true, force: true })
}
}
main().catch((err) => { console.error(err); process.exitCode = 1 })
