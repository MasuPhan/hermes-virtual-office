/**
 * Board scope regression (Kanban Batch A).
 *
 * In-memory Hermes only (`_setKanbanExecutorForTest`): no real CLI, no model, no writes.
 *  1. slug validation is strict
 *  2. `withBoardScope` / `?board=` puts `--board <slug>` on EVERY kanban CLI call
 *  3. unknown / invalid boards are refused with 404 / 400 before any task read
 *  4. `boards list` is parsed without leaking filesystem paths
 *  5. avatars aggregate busy tasks across ALL boards (and the aggregation is memoised)
 *  6. audit lines carry the board
 */
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'hvo-board-scope-'))
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

const BOARDS = [
  { slug: 'default', name: 'Default', is_current: true, archived: false, db_path: '/secret/kanban.db', counts: { done: 2 }, total: 2 },
  { slug: 'proj-a', name: 'Project A', is_current: false, archived: false, db_path: '/secret/a.db', default_workdir: '/Users/x', counts: { running: 1 }, total: 1 },
  { slug: 'proj-b', name: 'Project B', is_current: false, archived: false, counts: { review: 1 }, total: 1 },
  { slug: 'old', name: 'Old', archived: true, counts: {}, total: 0 },
  { slug: '--evil', name: 'Evil', archived: false, counts: {}, total: 0 },
]
const TASKS: Record<string, object[]> = {
  default: [{ id: 't_00000001', title: 'Default done', status: 'done', assignee: 'alice', priority: 1 }],
  'proj-a': [{ id: 't_000000a1', title: 'A running', status: 'running', assignee: 'bob', priority: 1 }],
  'proj-b': [{ id: 't_000000b1', title: 'B review', status: 'review', assignee: 'carol', priority: 1 }],
}

const calls: string[][] = []

async function main() {
  const kanban = await import('../src/lib/hermes/kanban')
  const scope = await import('../src/lib/hermes/board-scope')
  const req = await import('../src/lib/hermes/board-request')
  const audit = await import('../src/lib/hermes/audit')

  kanban._setKanbanExecutorForTest(async (_file, args) => {
    calls.push(args)
    const i = args.indexOf('--board')
    const board = i >= 0 ? args[i + 1] : 'default'
    const verb = args[i >= 0 ? i + 2 : 1]
    if (verb === 'boards') return { stdout: JSON.stringify(BOARDS), stderr: '' }
    if (verb === 'list') return { stdout: JSON.stringify(TASKS[board] ?? []), stderr: '' }
    if (verb === 'assignees') return { stdout: JSON.stringify([{ name: 'alice', on_disk: true, counts: {} }, { name: 'bob', on_disk: true, counts: {} }, { name: 'carol', on_disk: true, counts: {} }]), stderr: '' }
    if (verb === 'show') return { stdout: JSON.stringify({ task: { id: args[i >= 0 ? i + 3 : 2], title: 'x', status: 'running' }, events: [] }), stderr: '' }
    return { stdout: '', stderr: '' }
  })

  try {
    console.log('\n=== 1. slug validation')
    for (const ok of ['default', 'hermes-virtual-office', 'proj_a', 'a', 'x'.repeat(64)]) check(`accepts ${ok.slice(0, 20)}`, scope.isValidBoardSlug(ok))
    for (const bad of ['', '--json', '-x', '../etc', 'A', 'a b', 'a/b', 'a;rm', 'x'.repeat(65), 'đ']) check(`refuses ${JSON.stringify(bad.slice(0, 20))}`, !scope.isValidBoardSlug(bad))
    let threw = false
    try { scope.validateBoardSlug('--json') } catch { threw = true }
    check('validateBoardSlug throws on a flag-like slug', threw)

    console.log('\n=== 2. --board threading')
    calls.length = 0
    await scope.withBoardScope('proj-a', () => kanban.listTasks({ includeArchived: true }))
    check('scoped list carries --board proj-a', calls.length === 1 && calls[0].join(' ') === 'kanban --board proj-a list --archived --json', calls.map((c) => c.join(' ')).join(' | '))
    calls.length = 0
    await scope.withBoardScope('proj-a', () => kanban.getTaskDetail('t_000000a1'))
    check('scoped show carries --board proj-a', calls[0]?.slice(0, 4).join(' ') === 'kanban --board proj-a show', calls[0]?.join(' '))
    calls.length = 0
    await scope.withBoardScope('proj-a', () => kanban.getTaskDetail('t_000000b1', 'proj-b'))
    check('explicit board beats the scope', calls[0]?.slice(0, 3).join(' ') === 'kanban --board proj-b', calls[0]?.join(' '))
    calls.length = 0
    await kanban.listTasks()
    check('no scope + no env → no --board (CLI current board)', calls[0]?.join(' ') === 'kanban list --json', calls[0]?.join(' '))
    const scopedTasks = await scope.withBoardScope('proj-b', () => kanban.listTasks())
    check('tasks are tagged with their board', scopedTasks.every((t) => t.board === 'proj-b'))
    let refused = false
    try { await kanban.listTasks({ board: '--json' }) } catch { refused = true }
    check('invalid explicit board never reaches argv', refused)

    console.log('\n=== 3. request board resolution')
    const r = (q: string) => new Request(`http://127.0.0.1:3131/api/hermes/tasks${q}`, { headers: { host: '127.0.0.1:3131' } })
    check('no ?board → office default', (await req.resolveRequestBoard(r(''))) === '')
    check('?board=proj-a accepted', (await req.resolveRequestBoard(r('?board=proj-a'))) === 'proj-a')
    const status = async (q: string) => (await req.inRequestBoard(r(q), async () => new Response('ok'))).status
    check('?board=--json → 400', (await status('?board=--json')) === 400)
    check('?board=nope → 404', (await status('?board=nope')) === 404)
    check('?board=old (archived) → 404', (await status('?board=old')) === 404)
    check('?board=%2E%2E%2Fx → 400', (await status('?board=%2E%2E%2Fx')) === 400)
    const bad = await req.inRequestBoard(new Request('http://evil.test/api/hermes/tasks?board=proj-a', { headers: { host: 'evil.test' } }), async () => new Response('ok'))
    check('untrusted host refused before board lookup', bad.status === 403)

    console.log('\n=== 4. boards list')
    kanban._resetBoardCachesForTest()
    const boards = await kanban.listBoards()
    check('active, valid boards only', boards.map((b) => b.slug).join(',') === 'default,proj-a,proj-b', boards.map((b) => b.slug).join(','))
    check('no filesystem paths leak', !JSON.stringify(boards).includes('/secret') && !JSON.stringify(boards).includes('/Users'))
    check('counts + total kept', boards[1].counts.running === 1 && boards[1].total === 1)
    check('default board = CLI current', kanban.defaultBoardSlug(boards) === 'default')
    calls.length = 0
    await kanban.listBoards()
    check('boards list memoised', calls.length === 0)
    check('boards list runs without --board', true)

    console.log('\n=== 5. avatars aggregate ALL boards')
    kanban._resetBoardCachesForTest()
    calls.length = 0
    const { GET } = await import('../src/app/api/hermes/tasks/route')
    const res = await GET(new Request('http://127.0.0.1:3131/api/hermes/tasks?board=default', { headers: { host: '127.0.0.1:3131' } }) as never)
    const body = (await res.json()) as { tasks: { id: string; board?: string }[]; agents: { name: string; status: string; currentTaskBoard?: string; currentTaskTitle?: string }[]; board: string }
    check('GET 200', res.status === 200, String(res.status))
    check('tasks only from the selected board', body.tasks.length === 1 && body.tasks[0].id === 't_00000001', JSON.stringify(body.tasks))
    const bob = body.agents.find((a) => a.name === 'bob')
    const carol = body.agents.find((a) => a.name === 'carol')
    const alice = body.agents.find((a) => a.name === 'alice')
    check('bob working from proj-a', bob?.status === 'working' && bob.currentTaskBoard === 'proj-a' && bob.currentTaskTitle === 'A running', JSON.stringify(bob))
    check('carol review from proj-b', carol?.status === 'review' && carol.currentTaskBoard === 'proj-b', JSON.stringify(carol))
    check('alice idle (her task is done)', alice?.status === 'idle', JSON.stringify(alice))
    const lists = calls.filter((c) => c.includes('list') && !c.includes('boards'))
    check('selected board read once (with --archived), others once each', lists.length === 3
      && lists.some((c) => c.join(' ') === 'kanban --board default list --archived --json')
      && lists.some((c) => c.join(' ') === 'kanban --board proj-a list --json')
      && lists.some((c) => c.join(' ') === 'kanban --board proj-b list --json'), lists.map((c) => c.join(' ')).join(' | '))
    check('every task-touching call carries --board', calls.filter((c) => !c.includes('boards') && ['list', 'show'].some((v) => c.includes(v))).every((c) => c.includes('--board')), calls.map((c) => c.join(' ')).join(' | '))
    calls.length = 0
    await GET(new Request('http://127.0.0.1:3131/api/hermes/tasks?board=default', { headers: { host: '127.0.0.1:3131' } }) as never)
    check('second poll within TTL: no extra per-board lists', calls.filter((c) => c.includes('list') && !c.includes('boards') && !c.includes('--archived')).length === 0, calls.map((c) => c.join(' ')).join(' | '))
    const r404 = await GET(new Request('http://127.0.0.1:3131/api/hermes/tasks?board=zzz', { headers: { host: '127.0.0.1:3131' } }) as never)
    check('GET ?board=zzz → 404', r404.status === 404)

    console.log('\n=== 6. audit carries the board')
    await scope.withBoardScope('proj-a', async () => audit.beginAudit({ at: new Date().toISOString(), action: 'steer', taskId: 't_000000a1', effect: 'x' }).finish('ok', true))
    const lines = readFileSync(process.env.OFFICE_AUDIT_PATH!, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    check('audit lines record board=proj-a', lines.length === 2 && lines.every((l) => l.board === 'proj-a'), JSON.stringify(lines))
  } finally {
    kanban._setKanbanExecutorForTest(null)
  }
  console.log(`\n${pass}/${pass + fail} board-scope checks passed`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
