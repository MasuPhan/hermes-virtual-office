/**
 * Which Hermes kanban board a request works on.
 *
 * Hermes keeps one SQLite board per project (`hermes kanban boards list`). The office used to
 * read exactly one, fixed at process start by `HERMES_KANBAN_BOARD`. Now every kanban route
 * takes `?board=<slug>` and every CLI call made while serving it carries `--board <slug>`.
 *
 * The board rides on an AsyncLocalStorage scope instead of being threaded by hand through
 * ~40 bridge functions: `withBoardScope(slug, fn)` sets it for everything `fn` awaits, and
 * `kanban()` in kanban.ts reads it. A call that names a board explicitly still wins.
 *
 * Hard rule: the office NEVER runs `hermes kanban boards switch`. That changes the CLI's
 * global "current board" for every Hermes process on the machine; selecting a board here is
 * per-request only.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Board slugs as the CLI creates them: lowercase letters, digits, `-` and `_`, starting
 * with a letter or digit, at most 64 chars. Anything else is refused before it reaches argv
 * (argv is not a shell, but a slug like `--json` would still be read as a flag).
 */
export const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isValidBoardSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && BOARD_SLUG_RE.test(slug)
}

export function validateBoardSlug(slug: unknown): string {
  if (!isValidBoardSlug(slug)) {
    throw new BoardError('invalid_board', `Tên bảng không hợp lệ: ${JSON.stringify(String(slug)).slice(0, 80)}`, 400)
  }
  return slug
}

export class BoardError extends Error {
  constructor(
    readonly code: 'invalid_board' | 'unknown_board' | 'boards_unavailable',
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** The board configured for this office (`HERMES_KANBAN_BOARD`), or '' = the CLI's current board. */
export function envBoard(): string {
  const raw = (process.env.HERMES_KANBAN_BOARD || '').trim()
  return isValidBoardSlug(raw) ? raw : ''
}

const scope = new AsyncLocalStorage<{ board: string }>()

/** Run `fn` with every kanban CLI call scoped to `board` ('' = office default). */
export function withBoardScope<T>(board: string, fn: () => Promise<T>): Promise<T> {
  return scope.run({ board }, fn)
}

/** The board of the request being served, or undefined outside a scope. */
export function scopedBoard(): string | undefined {
  return scope.getStore()?.board || undefined
}
