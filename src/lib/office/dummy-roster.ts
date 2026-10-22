import type { DummySpec } from './db'

export function dummyRoster(): DummySpec[] {
  // No decorative dummy avatars in production.
  return []
}
