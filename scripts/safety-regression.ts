/**
 * HVO-SAFETY-01 focused regression tests.
 *
 * RUN BY THE PARENT, NOT BY THE AUTHORING SESSION. `node_modules` is absent in
 * this durable clone, so these tests were authored but not executed here.
 *
 * Defaults are deliberately inert:
 *   HERMES_BIN=/usr/bin/false, synthetic HOME/HERMES_HOME/TMPDIR, no network,
 *   no real model, no dispatch, no gateway, no live Hermes profiles.
 *
 * Every test uses a real helper/route where practical, with an injected
 * in-memory subprocess for the CLI boundary.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'hvo-safety-'))
const HOME = join(ROOT, 'home')
const HERMES = join(ROOT, 'hermes')
const TMP = join(ROOT, 'tmp')
mkdirSync(HOME, { recursive: true })
mkdirSync(HERMES, { recursive: true })
mkdirSync(TMP, { recursive: true })

process.env.HERMES_BIN = '/usr/bin/false'
process.env.HOME = HOME
process.env.HERMES_HOME = HERMES
process.env.HVO_HERMES_ROOT = HERMES
process.env.TMPDIR = TMP
process.env.HVO_MANAGEMENT_MODE = 'safe'
delete process.env.HVO_ALLOW_PRIVILEGED
process.env.OFFICE_DB_PATH = join(ROOT, 'office.db')
process.env.DATA_DIR = join(ROOT, 'data')
process.env.KANBAN_TIMEOUT_MS = '2000'
process.env.ALLOWED_ORIGINS = 'https://secure.example.com,office.example.com:3300'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}

function request(method: string, host: string, origin?: string, payload: unknown = {}): Request {
  const headers = new Headers({ host })
  if (origin) headers.set('origin', origin)
  return {
    method,
    headers,
    json: async () => payload,
  } as unknown as Request
}

function body(res: { json: () => Promise<unknown> } | null): Promise<Record<string, unknown>> {
  return res ? (res.json() as Promise<Record<string, unknown>>) : Promise.resolve({})
}

async function main(): Promise<void> {
  const policy = await import('../src/lib/api-policy')
  const guard = await import('../src/lib/local-guard')
  const names = await import('../src/lib/hermes/profile-name')
  const root = await import('../src/lib/hermes/root')
  const fallback = await import('../src/lib/hermes/fallback')

  console.log('\n=== ingress: read Host denial + exact https Origin ===')
  {
    const denied = policy.assertApiRequest(request('GET', 'attacker.example'), 'read')
    check('GET with attacker Host is denied', denied?.status === 403, String(denied?.status))
    const bodyDenied = await body(denied)
    check('read denial is forbidden_host', (bodyDenied.error as { code?: string })?.code === 'forbidden_host')
    const ok = policy.assertApiRequest(request('GET', '127.0.0.1:3000'), 'read')
    check('GET on loopback is allowed', ok === null)

    check('configured https origin accepted', guard.localOriginAllowed('secure.example.com', 'https://secure.example.com'))
    check('same host over http is refused for https entry', !guard.localOriginAllowed('secure.example.com', 'http://secure.example.com'))
    check('wrong port refused for https entry', !guard.localOriginAllowed('secure.example.com:8443', 'https://secure.example.com:8443'))
    check('foreign origin refused', !guard.localOriginAllowed('secure.example.com', 'https://evil.example'))
  }

  console.log('\n=== safe mode: write blocked, office-only persistence allowed ===')
  {
    const writeReq = request('POST', '127.0.0.1:3000', 'http://127.0.0.1:3000')
    const blocked = policy.assertApiRequest(writeReq, 'management-write')
    check('management write blocked in SAFE mode', blocked?.status === 403, String(blocked?.status))
    const blockedBody = await body(blocked)
    check('safe-mode denial is management_disabled', (blockedBody.error as { code?: string })?.code === 'management_disabled')
    const office = policy.assertApiRequest(writeReq, 'office-write')
    check('office-only SQLite write allowed in SAFE mode', office === null)
    const priv = policy.assertApiRequest(writeReq, 'privileged')
    check('privileged action blocked in SAFE mode', priv?.status === 403)

    const db = await import('../src/lib/office/db')
    db._resetOfficeDbForTest()
    const name = db.setOfficeName('Safety Office')
    db.saveAvatars([
      { avatarId: 'agent:regression', name: 'regression', division: 'tech', kind: 'agent', x: 1, z: 2, level: 0, activity: 'idle', facing: 0, spawned: true, anchored: false },
    ])
    check('office name persists in its own SQLite', name === 'Safety Office' && db.getOfficeName() === 'Safety Office')
    check('office avatar row persists', db.listAvatars().some((a) => a.avatarId === 'agent:regression'))
    db._resetOfficeDbForTest()
  }

  console.log('\n=== HVO-11: unsafe profile names rejected before path use ===')
  {
    for (const bad of ['..', '../escape', 'a/b', '', 'x'.repeat(65), 'Default!']) {
      let threw = false
      try { names.validateProfileName(bad) } catch { threw = true }
      check(`name ${JSON.stringify(bad)} rejected`, threw)
    }
    let dirThrew = false
    try { names.profileDir(HERMES, '..') } catch { dirThrew = true }
    check('profileDir refuses traversal', dirThrew)
    check('default rejected for profile-directory operations', (() => {
      try { names.profileDir(HERMES, 'default'); return false } catch { return true }
    })())
    check('default allowed for task assignee name', names.validateAssigneeName('default') === 'default')
  }

  console.log('\n=== HVO-07: explicit fleet root vs named-profile home ===')
  {
    check('explicit root wins', root.resolveFleetRoot({ HVO_HERMES_ROOT: '/tmp/explicit', HERMES_HOME: '/tmp/ignored' }, '/home/x') === '/tmp/explicit')
    check('normal HERMES_HOME root accepted', root.resolveFleetRoot({ HERMES_HOME: '/home/x/.hermes' }, '/home/x') === '/home/x/.hermes')
    let misScoped = false
    try { root.resolveFleetRoot({ HERMES_HOME: '/home/x/.hermes/profiles/example-agent' }, '/home/x') } catch { misScoped = true }
    check('named-profile HERMES_HOME fails closed', misScoped)
    let explicitMisScoped = false
    try {
      root.resolveFleetRoot(
        { HVO_HERMES_ROOT: '/home/x/.hermes/profiles/example-agent', HERMES_HOME: '/home/x/.hermes' },
        '/home/x',
      )
    } catch (err) {
      explicitMisScoped = (err as Error).message.includes('HVO_HERMES_ROOT')
    }
    check('named-profile HVO_HERMES_ROOT itself fails closed', explicitMisScoped)
    let envMisScoped = false
    try {
      root.fleetRootEnv({ HERMES_HOME: '/home/x/.hermes/profiles/example-agent' })
    } catch { envMisScoped = true }
    check('fleetRootEnv validates ambient HERMES_HOME before any CLI env is built', envMisScoped)
    const explicitEnv = root.fleetRootEnv({
      HVO_HERMES_ROOT: '/tmp/explicit',
      HERMES_HOME: '/home/x/.hermes/profiles/example-agent',
    })
    check('valid explicit root still wins and repoints the CLI env', explicitEnv.HERMES_HOME === '/tmp/explicit')
    check('no env falls back to synthetic home only', root.resolveFleetRoot({}, '/home/x') === '/home/x/.hermes')
  }

  console.log('\n=== HVO-01: A2A config mutation disabled, file preserved ===')
  {
    const cfg = join(ROOT, 'gateway.yaml')
    const original = 'platforms:\n  a2a:\n    enabled: true\n    port: 9900\n    agents: []\n'
    writeFileSync(cfg, original)
    const a2a = await import('../src/lib/hermes/a2a-served')
    a2a.setServedAgentsConfigPath(cfg)
    try {
      let up = false
      let rm = false
      try { await a2a.upsertServedAgent({ slug: 'x', description: 'd', advertisedToolsets: [] }) } catch (e) { up = /ĐÃ TẮT/.test((e as Error).message) }
      try { await a2a.removeServedAgent('x') } catch (e) { rm = /ĐÃ TẮT/.test((e as Error).message) }
      check('upsert refused with explicit disabled error', up)
      check('remove refused with explicit disabled error', rm)
      check('gateway config byte-identical after refusal', readFileSync(cfg, 'utf8') === original)
    } finally {
      a2a.setServedAgentsConfigPath(null)
    }
  }

  console.log('\n=== HVO-03: doctor GET is passive (no fetch / message-send) ===')
  {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (() => { fetchCalls++; throw new Error('network forbidden in regression test') }) as typeof fetch
    try {
      const doctor = await import('../src/lib/hermes/doctor')
      const report = await doctor.runDoctor({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })
      check('doctor ran without network', fetchCalls === 0, `fetch calls: ${fetchCalls}`)
      const ft = report.checks.find((c) => c.id === 'fallthrough')
      check('unavailable active probe is reported unknown', ft?.status === 'unknown', JSON.stringify(ft))
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  console.log('\n=== HVO-04: provider refusal preserves catalogue/model ===')
  {
    const kanban = await import('../src/lib/hermes/kanban')
    const calls: string[][] = []
    kanban._setKanbanExecutorForTest(async (_file, args) => {
      calls.push([...args])
      if (args.includes('custom_providers') && args.includes('get')) {
        // demo has no profile-scoped definition; demo2 already has one.
        const profile = args[args.indexOf('-p') + 1]
        return profile === 'demo2'
          ? { stdout: '[{"name":"x","base_url":"http://127.0.0.1:9/v1"}]', stderr: '' }
          : { stdout: '[]', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    try {
      let refused = false
      try { await kanban.setProfileModel('demo', 'm1', 'custom:x') } catch { refused = true }
      check('missing profile provider refused', refused)
      check('refusal writes nothing (no model.default)', !calls.some((a) => a.includes('model.default')))
      check('refusal never writes custom_providers', !calls.some((a) => a.includes('set') && a.includes('custom_providers')))

      calls.length = 0
      await kanban.setProfileModel('demo2', 'm2', 'custom:x')
      check('existing provider writes model.default', calls.some((a) => a.includes('model.default') && a.includes('m2')))
      check('existing provider writes model.provider', calls.some((a) => a.includes('model.provider') && a.includes('custom:x')))
      check('existing provider does NOT rewrite catalogue', !calls.some((a) => a.includes('set') && a.includes('custom_providers')))
    } finally {
      kanban._setKanbanExecutorForTest(null)
    }
  }

  console.log('\n=== HVO-05/HVO-08: dangerous operations disabled ===')
  {
    process.env.HVO_MANAGEMENT_MODE = 'write'
    process.env.HVO_ALLOW_PRIVILEGED = '1'
    const restart = await import('../src/app/api/hermes/gateway-restart/route')
    const r = await restart.POST(request('POST', '127.0.0.1:3000', 'http://127.0.0.1:3000') as never)
    const rb = (await r.json()) as { error?: { code?: string } }
    check('gateway restart returns 501', r.status === 501, String(r.status))
    check('gateway restart says restart_disabled', rb.error?.code === 'restart_disabled')

    const taskRoute = await import('../src/app/api/hermes/tasks/[id]/route')
    const tr = await taskRoute.POST(
      request('POST', '127.0.0.1:3000', 'http://127.0.0.1:3000', { action: 'run' }) as never,
      { params: Promise.resolve({ id: 't_12345678' }) },
    )
    const tb = (await tr.json()) as { error?: { code?: string } }
    check('ambiguous per-card run returns 501', tr.status === 501, String(tr.status))
    check('run says run_disabled', tb.error?.code === 'run_disabled')
    process.env.HVO_MANAGEMENT_MODE = 'safe'
    delete process.env.HVO_ALLOW_PRIVILEGED
  }

  console.log('\n=== HVO-12: selfrepair never deletes partial/unknown profile dirs ===')
  {
    const profiles = join(HERMES, 'profiles')
    mkdirSync(join(profiles, 'full'), { recursive: true })
    mkdirSync(join(profiles, 'partial', 'sessions'), { recursive: true })
    writeFileSync(join(profiles, 'full', 'config.yaml'), 'model: {}\n')
    writeFileSync(join(profiles, 'partial', 'sessions', 'state.db'), 'synthetic')
    mkdirSync(join(profiles, '.deleted'), { recursive: true })
    try { symlinkSync(join(profiles, 'full'), join(profiles, 'link')) } catch { /* platform */ }

    const selfrepair = await import('../src/lib/hermes/selfrepair')
    const preview = await selfrepair.previewRepairs()
    check('no stray-directory deletion is planned', !preview.planned.some((p) => p.kind === 'strayProfileDir'))
    check('partial profile reported for manual recovery', preview.unfixable.some((u) => u.target === 'partial'))
    check('partial profile still exists', existsSync(join(profiles, 'partial', 'sessions', 'state.db')))

    const kanban = await import('../src/lib/hermes/kanban')
    const listed = await kanban.listProfiles()
    check('symlinked directory is not treated as a profile', !listed.includes('link'))

    const perm = join(profiles, 'perm')
    mkdirSync(perm, { recursive: true })
    chmodSync(perm, 0o000)
    let accessThrew = false
    try { await kanban.listProfiles() } catch { accessThrew = true }
    check('permission error is not treated as absence', accessThrew)
    chmodSync(perm, 0o700)
  }

  console.log('\n=== HVO-13: backup is exclusive 0600 ===')
  {
    const cfg = join(ROOT, 'fallback-config.yaml')
    const content = 'custom_providers: []\n'
    writeFileSync(cfg, content, { mode: 0o644 })
    const backup = fallback.createSecureBackup(cfg, content)
    const mode = statSync(backup).mode & 0o777
    check('backup mode is 0600', mode === 0o600, mode.toString(8))
    check('backup content matches source', readFileSync(backup, 'utf8') === content)
  }

  console.log('\n=== HVO-09: same-agent chat serialized, other pointers preserved ===')
  {
    const dataDir = process.env.DATA_DIR!
    mkdirSync(dataDir, { recursive: true })
    const store = join(dataDir, 'chat-sessions.json')
    const other = {
      id: 'other_1', agent: 'other', profile: 'other', title: 'other',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 2,
    }
    writeFileSync(store, JSON.stringify({ other }, null, 2))

    const chat = await import('../src/lib/hermes/chat')
    const calls: string[][] = []
    let n = 0
    chat._setChatExecutorForTest(async (_file, args) => {
      calls.push([...args])
      await new Promise((r) => setTimeout(r, 5))
      n++
      return { stdout: `reply ${n}`, stderr: `session_id: sid_${n}` }
    })
    try {
      const [a1, a2, b] = await Promise.all([
        chat.sendChatMessage('same', 'same', 'one'),
        chat.sendChatMessage('same', 'same', 'two'),
        chat.sendChatMessage('different', 'different', 'hi'),
      ])
      // Let the per-agent cleanup microtasks run before inspecting the queue.
      await new Promise((r) => setTimeout(r, 0))
      const sessions = await chat.listChatSessions()
      const byAgent = new Map(sessions.map((s) => [s.agent, s] as const))
      check('other agent pointer preserved', byAgent.get('other')?.id === 'other_1')
      check('concurrent different agent pointer present', byAgent.get('different')?.id === b.session.id)
      check('same agent has one final pointer', byAgent.get('same')?.id === a2.session.id)
      check('same-agent second turn resumed the first session', calls.some((args) => args.includes('--resume') && args.includes(a1.session.id)))
      check('two same-agent turns did not reuse the same output id', a1.session.id !== a2.session.id)
      check('chat queue drained', chat._chatQueueSizeForTest() === 0, String(chat._chatQueueSizeForTest()))
      check('index atomic write mode is 0600', (statSync(store).mode & 0o777) === 0o600, (statSync(store).mode & 0o777).toString(8))
    } finally {
      chat._setChatExecutorForTest(null)
    }
  }

  console.log('\n=== route coverage: every API handler calls the central policy ===')
  {
    const apiRoot = join(process.cwd(), 'src', 'app', 'api')
    const files = (readdirSync(apiRoot, { recursive: true }) as unknown as string[])
      .filter((f) => f.endsWith('route.ts'))
    const missing: string[] = []
    for (const f of files) {
      const src = readFileSync(join(apiRoot, f), 'utf8')
      const handlers = src.match(/export async function (GET|POST|PUT|PATCH|DELETE)/g) ?? []
      const guards = src.match(/assertApiRequest\(/g) ?? []
      if (guards.length < handlers.length) missing.push(f)
    }
    check(`all ${files.length} API route files guard every handler`, missing.length === 0, missing.join(', '))
  }

  console.log('\n=== package/docs contracts ===')
  {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { engines?: { node?: string } }
    check('Node engine pins the verified node:sqlite baseline', pkg.engines?.node === '>=22.22.3', String(pkg.engines?.node))
    const kanbanSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'hermes', 'kanban.ts'), 'utf8')
    check('profile create passes --no-skills (matches docs)', /'--no-skills'/.test(kanbanSrc))
  }

  console.log(`\n${checks - failures}/${checks} safety regression checks passed`)
  if (failures) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error('SAFETY REGRESSION THREW:', err)
    process.exitCode = 1
  })
  .finally(() => {
    try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ }
  })
