/**
 * Office membership: which Hermes profiles appear in the 3D office.
 *
 * The office is driven by the assignee list, so every profile would otherwise be
 * in the room at once. This module adds a hide list on top: a hidden profile stops
 * being returned (its avatar walks out and despawns), and spawning it brings it
 * back in through the front door. The profile itself is never touched here — that
 * is the destructive `kill` action in the agents route.
 *
 * Hidden names live in memory for the life of the server process. That is a
 * deliberate trade: persisting it would mean writing office state into the Hermes
 * install, which this app otherwise never does. A restart restores the default
 * (everyone visible). Documented in docs/API-SPEC.md.
 */

/**
 * Profiles that are NEVER part of the office, no matter what.
 *
 * The office now runs without built-in hidden profiles. All profiles from the
 * assignee list are visible by default. Individual profiles can still be hidden
 * at runtime via the UI, and a restart restores full visibility.
 */
export const BUILTIN_HIDDEN = new Set<string>()

const hidden = new Set<string>()

/** Names currently removed from the office (runtime hides + the built-in ones). */
export function hiddenNames(): string[] {
  return [...new Set([...BUILTIN_HIDDEN, ...hidden])].sort()
}

export function isHidden(name: string): boolean {
  return BUILTIN_HIDDEN.has(name) || hidden.has(name)
}

/** Remove a profile from the office. Returns false if it was already gone. */
export function hide(name: string): boolean {
  if (isHidden(name)) return false
  hidden.add(name)
  return true
}

/** Bring a profile back. Returns false if it was not hidden. */
export function show(name: string): boolean {
  // Keep any future built-in exclusions separate from runtime hides.
  if (BUILTIN_HIDDEN.has(name)) return false
  return hidden.delete(name)
}

/** Filter a list of names down to those the office should show. */
export function visible<T extends { name: string }>(list: T[]): T[] {
  return list.filter((x) => !isHidden(x.name))
}

/** Filter a list of plain names, for the routes that only carry strings. */
export function visibleNames(list: string[]): string[] {
  return list.filter((n) => !isHidden(n))
}
