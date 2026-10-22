/**
 * Archive / delete regression (feat/kanban-archive). In-memory fake CLI, no real Hermes.
 *   1. id validation   2. write guard + audit of refusals   3. board threading (--board)
 *   4. running cards refused   5. delete needs the exact confirm token, archive→--rm
 *   6. unarchive is 501 with no CLI call   7. partial failure reported per id   8. chunking
 */
import { mkdtempSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'hvo-archive-'))
mkdirSync(join(root, 'profiles'), { recursive: true })
process.env.HVO_HERMES_ROOT = root
process.env.HERMES_HOME = root
process.env.OFFICE_AUDIT_PATH = join(root, 'audit.jsonl')
delete process.env.HERMES_KANBAN_BOARD

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`)
}

type Row = { id: string; title: string; status: string; assignee?: string | null }
const DB: Record<string, Row[]> = {}
function reset() {
  DB.default = [{ id: 't_0000d001', title: 'Default done', status: 'done', assignee: 'alice' }]
  DB['proj-a'] = [
    { id: 't_0000a001', title: 'A done', status: 'done', assignee: 'bob' },
    { id: 't_0000a002', title: 'A running', status: 'running', assignee: 'bob' },
    { id: 't_0000a003', title: 'A archived', status: 'archived', assignee: 'bob' },
    { id: 't_0000a004', title: 'A todo', status: 'todo', assignee: null },
    { id: 't_0000a005', title: 'A refused by CLI', status: 'done', assignee: null },
  ]
  for (let i = 0; i < 45; i++) DB.default.push({ id: `t_bulk${String(i).padStart(4, '0')}`, title: `bulk ${i}`, status: 'done' })
}
const calls: string[][] = []
const writes = () => calls.filter((c) => c.includes('archive'))

async function main() {
  reset()
  const kanban = await import('../src/lib/hermes/kanban')
  const ta = await import('../src/lib/hermes/task-archive')
  kanban._setKanbanExecutorForTest(async (_file, args) => {
    calls.push(args)
    const i = args.indexOf('--board')
    const board = i >= 0 ? args[i + 1] : 'default'
    const rest = args.slice(i >= 0 ? i + 2 : 1).filter((x) => x !== '--json')
    const out = (v: unknown) => ({ stdout: JSON.stringify(v), stderr: '' })
    if (rest[0] === 'boards') return out(Object.keys(DB).map((slug) => ({ slug, name: slug, archived: false, counts: {}, total: DB[slug].length })))
    const rows = DB[board]
    if (!rows) throw Object.assign(new Error('unknown board'), { stderr: 'unknown board' })
    if (rest[0] === 'list') return out(rest.includes('--archived') ? rows : rows.filter((r) => r.status !== 'archived'))
    if (rest[0] === 'assignees') return out([])
    if (rest[0] === 'archive') {
      const purge = rest[1] === '--rm'
      const ids = rest.slice(purge ? 2 : 1)
      let bad = false
      for (const id of ids) {
        const r = rows.find((x) => x.id === id)
        if (!r || id === 't_0000a005') { bad = true; continue }
        if (purge) {
          if (r.status !== 'archived') { bad = true; continue }
          rows.splice(rows.indexOf(r), 1)
        } else if (r.status === 'archived') bad = true
        else r.status = 'archived'
      }
      if (bad) throw Object.assign(new Error('exit 1'), { stderr: 'cannot archive' })
      return { stdout: 'ok', stderr: '' }
    }
    return { stdout: '[]', stderr: '' }
  })
  const { POST } = await import('../src/app/api/hermes/tasks/archive/route')
  const H = { host: '127.0.0.1:3131', origin: 'http://127.0.0.1:3131', 'content-type': 'application/json' }
  const post = (q: string, body: unknown, headers: Record<string, string> = H) =>
    POST(new Request(`http://127.0.0.1:3131/api/hermes/tasks/archive${q}`, { method: 'POST', headers, body: JSON.stringify(body) }) as never)
  const audit = () => (existsSync(process.env.OFFICE_AUDIT_PATH!) ? readFileSync(process.env.OFFICE_AUDIT_PATH!, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])

  try {
    console.log('\n=== 1. id validation')
    const v = (x: unknown) => { try { ta.validateIds(x); return 'ok' } catch (e) { return (e as { code: string }).code } }
    check('empty list refused', v([]) === 'invalid_request')
    check('non-array refused', v('t_0000a001') === 'invalid_request')
    check('>100 ids refused', v(Array.from({ length: 101 }, (_, i) => `t_x${String(i).padStart(4, '0')}`)) === 'invalid_request')
    check('flag-like id refused', v(['--rm']) === 'invalid_task_id')
    check('path-like id refused', v(['t_../../x']) === 'invalid_task_id')
    check('id with space refused', v(['t_0000 a001']) === 'invalid_task_id')
    check('duplicates collapsed', JSON.stringify(ta.validateIds(['t_0000a001', 't_0000a001'])) === '["t_0000a001"]')
    check('confirm token is order-independent', ta.deleteConfirmToken(['t_b0000', 't_a0000']) === ta.deleteConfirmToken(['t_a0000', 't_b0000']))

    console.log('\n=== 2. write guard')
    process.env.HVO_MANAGEMENT_MODE = 'safe'
    delete process.env.HVO_ALLOW_PRIVILEGED
    calls.length = 0
    const r1 = await post('?board=proj-a', { action: 'archive', ids: ['t_0000a001'] })
    check('safe mode: archive → 403', r1.status === 403, String(r1.status))
    check('safe mode: no CLI write', writes().length === 0)
    const deny = audit().at(-1)
    check('refusal audited with board + id', deny?.action === 'kanban-archive' && deny.ok === false && deny.board === 'proj-a' && deny.taskId === 't_0000a001', JSON.stringify(deny))
    process.env.HVO_MANAGEMENT_MODE = 'write'
    const r2 = await post('?board=proj-a', { action: 'delete', ids: ['t_0000a001'], confirm: ta.deleteConfirmToken(['t_0000a001']) })
    check('write without privileged: delete → 403', r2.status === 403, String(r2.status))
    const r3 = await post('?board=proj-a', { action: 'archive', ids: ['t_0000a001'] }, { host: '127.0.0.1:3131', 'content-type': 'application/json' })
    check('missing Origin → 403', r3.status === 403, String(r3.status))
    const r4 = await post('?board=proj-a', { action: 'archive', ids: ['t_0000a001'] }, { ...H, host: 'evil.example' })
    check('untrusted Host → 403', r4.status === 403, String(r4.status))
    check('no CLI write from any refused request', writes().length === 0, JSON.stringify(writes()))

    console.log('\n=== 3. board threading + validation')
    const r5 = await post('?board=BAD!', { action: 'archive', ids: ['t_0000a001'] })
    check('bad slug → 400', r5.status === 400)
    const r6 = await post('?board=nope', { action: 'archive', ids: ['t_0000a001'] })
    check('unknown board → 404', r6.status === 404)
    const r7 = await post('?board=proj-a', { action: 'archive', ids: ['bad id'] })
    check('bad id → 400 before any CLI call', r7.status === 400 && writes().length === 0)
    const r8 = await post('?board=proj-a', { action: 'frobnicate', ids: ['t_0000a001'] })
    check('unknown action → 400', r8.status === 400)

    console.log('\n=== 4. archive')
    calls.length = 0
    const r9 = await post('?board=proj-a', { action: 'archive', ids: ['t_0000a001', 't_0000a002', 't_0000a003', 't_0000d001'] })
    const b9 = (await r9.json()) as { results: { id: string; ok: boolean; code?: string }[] }
    const by = Object.fromEntries(b9.results.map((r) => [r.id, r]))
    check('archive → 200 with per-id results', r9.status === 200 && b9.results.length === 4, JSON.stringify(b9))
    check('done card archived', by.t_0000a001?.ok === true && DB['proj-a'][0].status === 'archived')
    check('running card refused, untouched', by.t_0000a002?.code === 'running' && DB['proj-a'][1].status === 'running')
    check('already archived reported', by.t_0000a003?.code === 'already_archived')
    check('id from another board = not_found (no cross-board write)', by.t_0000d001?.code === 'not_found' && DB.default[0].status === 'done')
    check('exact CLI write: kanban --board proj-a archive t_0000a001', JSON.stringify(writes()) === JSON.stringify([['kanban', '--board', 'proj-a', 'archive', 't_0000a001']]), JSON.stringify(writes()))
    const al = audit().slice(-2)
    check('audit: intent + result with board and ids', al[0]?.action === 'kanban-archive' && al[0].board === 'proj-a' && al[0].taskId.includes('t_0000a002') && al[1]?.ok === false && /t_0000a002:running/.test(al[1].result), JSON.stringify(al))

    console.log('\n=== 5. delete')
    process.env.HVO_ALLOW_PRIVILEGED = '1'
    calls.length = 0
    const r10 = await post('?board=proj-a', { action: 'delete', ids: ['t_0000a004'] })
    check('delete without confirm → 400, no write', r10.status === 400 && writes().length === 0)
    const r11 = await post('?board=proj-a', { action: 'delete', ids: ['t_0000a004'], confirm: ta.deleteConfirmToken(['t_0000a003']) })
    check('confirm for other ids → 400, no write', r11.status === 400 && writes().length === 0)
    const r12 = await post('?board=proj-a', { action: 'delete', ids: ['t_0000a004', 't_0000a003', 't_0000a002'], confirm: ta.deleteConfirmToken(['t_0000a002', 't_0000a003', 't_0000a004']) })
    const b12 = (await r12.json()) as { results: { id: string; ok: boolean; code?: string }[] }
    check('delete → 200, live + archived cards gone', r12.status === 200 && !DB['proj-a'].some((r) => r.id === 't_0000a004' || r.id === 't_0000a003'), JSON.stringify(b12))
    check('running card not deleted', DB['proj-a'].some((r) => r.id === 't_0000a002') && b12.results.find((r) => r.id === 't_0000a002')?.code === 'running')
    check('exact CLI writes: archive live first, then archive --rm both', JSON.stringify(writes()) === JSON.stringify([
      ['kanban', '--board', 'proj-a', 'archive', 't_0000a004'],
      ['kanban', '--board', 'proj-a', 'archive', '--rm', 't_0000a004', 't_0000a003'],
    ]), JSON.stringify(writes()))
    check('delete audited as kanban-delete', audit().slice(-2).every((l) => l.action === 'kanban-delete' && l.board === 'proj-a'))

    console.log('\n=== 6. unarchive')
    calls.length = 0
    const r13 = await post('?board=proj-a', { action: 'unarchive', ids: ['t_0000a001'] })
    check('unarchive → 501, no CLI write', r13.status === 501 && writes().length === 0, String(r13.status))

    console.log('\n=== 7. partial failure')
    calls.length = 0
    const r14 = await post('?board=proj-a', { action: 'archive', ids: ['t_0000a005'] })
    const b14 = (await r14.json()) as { results: { id: string; ok: boolean; code?: string }[] }
    check('CLI refusal → 409 with code refused', r14.status === 409 && b14.results[0].code === 'refused', JSON.stringify(b14))

    console.log('\n=== 8. bulk on the default board (no ?board)')
    calls.length = 0
    const bulk = DB.default.filter((r) => r.id.startsWith('t_bulk')).map((r) => r.id)
    const r15 = await post('', { action: 'archive', ids: bulk })
    const b15 = (await r15.json()) as { results: { ok: boolean }[] }
    check('45 cards archived', r15.status === 200 && b15.results.filter((r) => r.ok).length === 45)
    check('chunked into 40 + 5, no --board flag', writes().length === 2 && writes()[0].length === 2 + 40 && writes().every((c) => !c.includes('--board')), JSON.stringify(writes().map((c) => c.length)))
    check('unscoped write still names a board in the audit', audit().at(-1)?.board === '(cli-current)', JSON.stringify(audit().at(-1)))
  } finally {
    kanban._setKanbanExecutorForTest(null)
  }
  console.log(`\n${pass}/${pass + fail} archive checks passed`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
