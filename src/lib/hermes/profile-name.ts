/**
 * Profile-name validation shared by API boundaries and filesystem helpers.
 *
 * Why this exists: several routes used a caller-supplied string directly in
 * `path.join(hermesHome(), 'profiles', name)`. A name such as `..` resolves to
 * the Hermes root, so a cleanup path could delete far more than one profile.
 * The API must reject traversal-shaped names BEFORE any CLI or filesystem write,
 * regardless of what the installed CLI happens to accept.
 *
 * `default` is the install's own root profile. It is a valid read name but is
 * never a directory under `profiles/`, so profile-directory operations reject it.
 */
import path from 'node:path'

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class ProfileNameError extends Error {
  readonly code = 'invalid_profile_name'
  constructor(message: string) {
    super(message)
    this.name = 'ProfileNameError'
  }
}

export function isSafeProfileName(raw: unknown, opts: { allowDefault?: boolean } = {}): boolean {
  const name = String(raw ?? '').trim().toLowerCase()
  if (!PROFILE_NAME.test(name)) return false
  if (!opts.allowDefault && name === 'default') return false
  return true
}

/**
 * Normalize and validate a profile/assignee name.
 *
 * Throws instead of returning a sentinel so a caller cannot accidentally keep
 * going with an unchecked value.
 */
export function validateProfileName(raw: unknown, opts: { allowDefault?: boolean } = {}): string {
  const name = String(raw ?? '').trim().toLowerCase()
  if (!PROFILE_NAME.test(name)) {
    throw new ProfileNameError(
      'Tên hồ sơ chỉ gồm chữ thường/chữ số (cho phép - và _), tối đa 64 ký tự; ' +
        'không chấp nhận đường dẫn vượt thư mục và tên trống',
    )
  }
  if (!opts.allowDefault && name === 'default') {
    throw new ProfileNameError('Hồ sơ "default" không nằm trong thư mục profiles/ và không được dùng ở đây')
  }
  return name
}

/** Assignee names are profile names; `default` is a real (root) profile. */
export function validateAssigneeName(raw: unknown): string {
  return validateProfileName(raw, { allowDefault: true })
}

/**
 * Canonical profile directory with containment check.
 *
 * The validation above already forbids separators, but the containment check is
 * kept as defence in depth: a future regex change cannot silently reintroduce a
 * path escape.
 */
export function profileDir(root: string, raw: unknown): string {
  const clean = validateProfileName(raw)
  const profiles = path.resolve(root, 'profiles')
  const dir = path.resolve(profiles, clean)
  const rel = path.relative(profiles, dir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ProfileNameError(`Tên hồ sơ "${String(raw)}" nằm ngoài thư mục profiles/`)
  }
  return dir
}
