/**
 * Chat bridge.
 *
 * Talk to an agent directly, with memory, over the Hermes CLI.
 *
 * ## Why the CLI and not a new database
 *
 * Hermes already keeps a per-profile SQLite session store (`state.db`) with full
 * message history — this install has 117 sessions and 41k messages in it. The office
 * had no chat, but the memory layer it needs already exists and is battle-tested.
 * Writing a second store would mean two sources of truth for "what was said".
 *
 * So: `hermes -p <profile> chat -q <message> -Q` answers and prints a `session_id`, and
 * `--resume <session_id>` continues that conversation with its history intact. `-Q`
 * already selects one-shot behavior; do not add the redundant `--oneshot` flag.
 * Measured working:
 *
 *   -p default chat -q "remember the cat is called Bleki" -Q  -> session_id + "Oke."
 *   -p default chat --resume <id> -q "what is my cat called?" -Q -> "Bleki."
 *
 * ## Isolation is per PROFILE, which is why chat gets its own
 *
 * Each profile has its own `state.db`, so conversations with different profiles do
 * not mix. That is exactly what we want, and it also solves a cost problem: the
 * `default` profile carries a ~66,000-character `system_prompt` in its config.yaml,
 * sent on every single message. Chatting through it would mean ~16k tokens per
 * "hello". A profile created with `--no-skills` and no cloned config has a 2 KB
 * config and a short SOUL.md, so a turn costs a fraction of that.
 *
 * ## The session id is the memory
 *
 * There is no separate "memory" to manage: the session id IS the conversation's
 * identity. Storing it is what makes the next message continue the thread. We keep
 * the mapping from an office agent to its session in the office's own data dir.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fleetRootEnv } from './root'
import { errorTail } from './redact'

const run = promisify(execFile)

const HERMES_BIN = process.env.HERMES_BIN || 'hermes'
/** Generous: an agent turn may run tools before answering. */
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS || 180_000)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')

type ChatExec = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }>
let testExecutor: ChatExec | null = null

/** In-memory subprocess seam for regression tests; production never uses it. */
export function _setChatExecutorForTest(fn: ChatExec | null): void {
  testExecutor = fn
}

async function exec(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  if (testExecutor) return testExecutor(file, args, options)
  const r = await run(file, args, options)
  return { stdout: String(r.stdout), stderr: String(r.stderr) }
}

/**
 * Env without the agent-session markers.
 *
 * The CLI refuses to run inside a delegated worker context. The office is a server,
 * not a worker, but it may have been started from inside one — so strip the markers
 * the same way the kanban bridge does.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = fleetRootEnv(process.env)
  for (const k of [
    'HERMES_DELEGATED_CHILD_CONTEXT',
    'HERMES_SUPERVISED_CHILD',
    'HERMES_SESSION_ID',
    'HERMES_SESSION_PLATFORM',
    'HERMES_SESSION_CHAT_ID',
    'HERMES_SESSION_USER_ID',
    'HERMES_KANBAN_TASK',
    'HERMES_KANBAN_WORKSPACE',
    'HERMES_KANBAN_BRANCH',
  ]) {
    delete env[k]
  }
  return env
}

export function officeChatArgs(profile: string, message: string, sessionId?: string): string[] {
  const args = ['-p', profile, 'chat']
  if (sessionId) args.push('--resume', sessionId)
  args.push('-q', message, '-Q')
  return args
}

/**
 * Run the CLI and return BOTH streams.
 *
 * The `session_id` line is written to **stderr**, while the answer goes to stdout —
 * measured, not assumed. An earlier version read stdout only and every send failed
 * with "tidak bisa membaca session_id", because the id was never in the stream it
 * looked at. The first probe missed it because it merged the streams with `2>&1`.
 *
 * stderr is not an error channel here: the CLI uses it for its banner and session
 * line. Only a non-zero exit or a killed process means failure.
 */
async function cli(args: string[], timeout = CHAT_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(HERMES_BIN, args, {
      env: cleanEnv(),
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { stdout, stderr }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      killed?: boolean
    }
    if (e.code === 'ENOENT') {
      throw new Error(`Không tìm thấy Hermes CLI tại "${HERMES_BIN}". Hãy đặt HERMES_BIN.`)
    }
    // A timeout still carries partial output; an answer may be in there.
    const partial = [e.stdout, e.stderr].filter(Boolean).join('\n').trim()
    if (e.killed || (err as Error).name === 'AbortError') {
      throw new Error(
        `Tác tử không trả lời trong ${Math.round(timeout / 1000)} giây` +
          (partial ? ` (đầu ra một phần: ${errorTail({ stderr: partial }, 200)})` : ''),
      )
    }
    throw new Error(`hermes chat thất bại: ${errorTail(e)}`)
  }
}

/* ------------------------------------------------------------------- sessions -- */

export type ChatSession = {
  /** Hermes session id — the memory handle. */
  id: string
  /** Office agent this thread belongs to. */
  agent: string
  /** Profile the CLI actually ran as. */
  profile: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  /** Last few exchanges, for the thread list. */
  preview?: string
}

export type ChatMessage = {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  ts: number
}

/** Where the office keeps its own chat index. */
function storePath(): string {
  return path.join(DATA_DIR, 'chat-sessions.json')
}

/**
 * The office's index of chat sessions.
 *
 * The CLI's session store is the source of truth for MESSAGES; this file only maps
 * an office agent to the session id that holds its thread. Keeping it separate means
 * we never write to Hermes' database directly, and a lost index costs a thread
 * pointer, not the history — which is still in `state.db` and recoverable by
 * `sessions list`.
 */
async function readIndex(): Promise<Record<string, ChatSession>> {
  try {
    const raw = await readFile(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => {
        if (!value || typeof value !== 'object') return false
        const session = value as Partial<ChatSession>
        return typeof session.id === 'string' && typeof session.agent === 'string' &&
          typeof session.profile === 'string' && typeof session.title === 'string' &&
          typeof session.createdAt === 'string' && typeof session.updatedAt === 'string' &&
          typeof session.messageCount === 'number'
      }),
    ) as Record<string, ChatSession>
  } catch {
    return {}
  }
}

async function writeIndex(index: Record<string, ChatSession>): Promise<void> {
  const target = storePath()
  await mkdir(path.dirname(target), { recursive: true })
  // Atomic replace: a crash mid-write must not leave a truncated index that
  // loses every agent's pointer. Write a sibling temp file then rename.
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(index, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, target)
  } catch (err) {
    try { await unlink(tmp) } catch { /* best effort */ }
    throw err
  }
}

/** Single-process transaction fence for the SHARED index. Model calls stay outside.
 * Atomic rename alone cannot prevent two read/merge/write operations losing updates.
 * All index mutations, including resets, must hold this short lock.
 */
let indexQueue: Promise<unknown> = Promise.resolve()
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexQueue.catch(() => undefined).then(fn)
  indexQueue = next.then(() => undefined, () => undefined)
  return next
}

/**
 * Serialize turns for the SAME agent. Different agents may run concurrently;
 * their index merges must still be based on the latest file, not a snapshot
 * taken before the model call (HVO-09).
 */
const agentQueues = new Map<string, Promise<unknown>>()

function withAgentLock<T>(agent: string, fn: () => Promise<T>): Promise<T> {
  const key = agent.trim().toLowerCase()
  const prev = agentQueues.get(key) ?? Promise.resolve()
  const runNext = prev.catch(() => undefined).then(fn)
  agentQueues.set(key, runNext)
  // Drop the queue entry once this turn is the tail, so the map cannot grow
  // forever in a long-lived server process.
  const cleanup = () => {
    if (agentQueues.get(key) === runNext) agentQueues.delete(key)
  }
  void runNext.then(cleanup, cleanup)
  return runNext
}

/** Exposed for tests: no live model call is ever made by a regression test. */
export function _chatQueueSizeForTest(): number {
  return agentQueues.size
}

/** Every known thread, newest activity first. */
export async function listChatSessions(): Promise<ChatSession[]> {
  const index = await readIndex()
  return Object.values(index).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getChatSession(agent: string): Promise<ChatSession | null> {
  const index = await readIndex()
  return index[agent] ?? null
}

/* --------------------------------------------------------------------- sending -- */

/** `session_id: 20260927_112902_6d5219` — printed by the CLI on every turn. */
const SESSION_RE = /session_id:\s*([A-Za-z0-9_]+)/

/**
 * Strip the CLI's decorations from a reply.
 *
 * With `-Q` the CLI prints only the answer plus a session line, but it also emits
 * notices on stderr-style lines that land in stdout in some versions (an unknown
 * toolset warning, a "Resumed session ..." banner). Those are not part of the
 * answer and must not be shown as if the agent said them.
 */
function cleanReply(stdout: string): string {
  return stdout
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      if (!t) return true
      if (/^session_id:/.test(t)) return false
      if (/^↻\s*Resumed session/.test(t)) return false
      if (/^Warning: Unknown toolsets:/.test(t)) return false
      if (/^Error: Profile .* does not exist/.test(t)) return false
      // Environment notices the CLI prints before the answer. They describe the
      // host, not what the agent said, and showing them as the reply is wrong.
      if (/tirith security scanner/.test(t)) return false
      if (/^⚠/.test(t)) return false
      if (/^↻/.test(t)) return false
      return true
    })
    .join('\n')
    .trim()
}

/**
 * Agent yang turn chat-nya SEDANG berjalan di proses server ini.
 *
 * `sendChatMessage` menunggu CLI sampai selesai (bisa ratusan detik kalau agent memakai tools),
 * dan selama itu `updatedAt` sesi belum berubah — jadi indeks sesi saja tidak bisa bilang
 * "agent ini sedang bekerja". Hanya proses yang menjalankan CLI yang tahu, maka dicatat di sini.
 * Hitungan, bukan boolean: dua tab yang mengirim bersamaan tidak boleh saling menghapus.
 */
const inFlight = new Map<string, number>()

export function chatTurnsInFlight(): string[] {
  return [...inFlight.keys()].sort()
}

export type SendResult = {
  session: ChatSession
  /** The agent's reply, cleaned of CLI decoration. */
  reply: string
}

/**
 * Send a message to an agent and return its reply.
 *
 * Resumes the agent's existing thread when there is one, so the conversation keeps
 * its memory; otherwise starts a new session and records it.
 */
export async function sendChatMessage(
  agent: string,
  profile: string,
  message: string,
): Promise<SendResult> {
  const text = message.trim()
  if (!text) throw new Error('Tin nhắn trống')
  if (text.length > 60_000) {
    throw new Error('Tin nhắn quá dài (tối đa 60.000 ký tự)')
  }

  // One turn at a time per agent: two tabs cannot resume the same session
  // concurrently. Other agents keep running in parallel.
  return withAgentLock(agent, async () => {
    // Snapshot only to decide whether this turn resumes; the authoritative read
    // happens again after the model call, under the same agent lock.
    const before = await readIndex()
    const existing = before[agent]
    const args = officeChatArgs(profile, text, existing?.id)

    inFlight.set(agent, (inFlight.get(agent) ?? 0) + 1)
    let out: { stdout: string; stderr: string }
    try {
      out = await cli(args)
    } finally {
      const n = (inFlight.get(agent) ?? 1) - 1
      if (n > 0) inFlight.set(agent, n)
      else inFlight.delete(agent)
    }
    const { stdout, stderr } = out
    const reply = cleanReply(stdout)
    // The session line arrives on stderr; the answer on stdout. Search both so a
    // future CLI version moving the line does not break this again.
    const id = SESSION_RE.exec(stderr)?.[1] || SESSION_RE.exec(stdout)?.[1] || existing?.id
    if (!id) {
      const where = errorTail({ stderr: `${stdout}\n${stderr}`.trim() }, 300)
      throw new Error(`Không thể đọc session_id từ đầu ra CLI: ${where}`)
    }

    const now = new Date().toISOString()
    // Re-read the LATEST index after the turn and merge only THIS agent's entry.
    // Writing the pre-turn snapshot would erase pointers created concurrently by
    // other agents.
    return withIndexLock(async () => {
    const latest = await readIndex()
    const prior = latest[agent] ?? existing
    const session: ChatSession = {
      id,
      agent,
      profile,
      // The CLI names a session from its first message; mirror that so the thread list
      // reads like a chat app rather than a list of opaque ids.
      title: prior?.title || text.slice(0, 60),
      createdAt: prior?.createdAt || now,
      updatedAt: now,
      messageCount: (prior?.messageCount ?? 0) + 2,
    }
    latest[agent] = session
    await writeIndex(latest)

    return { session, reply }
    })
  })
}

/* ------------------------------------------------------------------- history -- */

/**
 * Read a session's messages.
 *
 * `sessions export --format jsonl` writes the whole session (metadata + `messages[]`)
 * as one JSON document. `--session-id <id> -` sends it to stdout.
 *
 * The export is per PROFILE: a session in `office-chat`'s state.db is invisible to a
 * `default`-profile export and vice versa, so `-p <profile>` is required to match the
 * session that was created there.
 */
export async function readChatHistory(
  profile: string,
  sessionId: string,
  limit = 200,
): Promise<ChatMessage[]> {
  let out: string
  try {
    const r = await cli(
      ['-p', profile, 'sessions', 'export', '--format', 'jsonl', '--session-id', sessionId, '-'],
      60_000,
    )
    // The export writes JSON to stdout, but take stderr too in case a version
    // routes notices there.
    out = r.stdout.includes('{') ? r.stdout : r.stdout + '\n' + r.stderr
  } catch {
    return []
  }

  const start = out.indexOf('{')
  if (start < 0) return []
  let doc: { messages?: Record<string, unknown>[] }
  try {
    doc = JSON.parse(out.slice(start))
  } catch {
    return []
  }

  const msgs = Array.isArray(doc.messages) ? doc.messages : []
  const out2: ChatMessage[] = []
  for (const m of msgs) {
    const role = String(m.role ?? '')
    if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') continue
    const content = typeof m.content === 'string' ? m.content.trim() : ''
    // Skip empty assistant turns: those are tool-call frames, and the tool result
    // follows as its own message. Showing them as blank bubbles looks broken.
    if (!content) continue
    if (role === 'tool') continue
    if (role === 'system') continue
    out2.push({
      role,
      content,
      ts: typeof m.timestamp === 'number' ? m.timestamp * 1000 : Date.now(),
    })
  }
  return out2.slice(-limit)
}

/** Forget an agent's thread pointer. The history stays in Hermes' store. */
export async function resetChatSession(agent: string): Promise<void> {
  return withAgentLock(agent, () => withIndexLock(async () => {
    const index = await readIndex()
    delete index[agent]
    await writeIndex(index)
  }))
}
