/**
 * Fleet-root resolution — the install root, NOT a named profile home.
 *
 * The office reads the fleet roster from `<root>/profiles`. It must never treat
 * `$HERMES_HOME` as the fleet root when that variable points at a named profile
 * (`…/profiles/<name>`), because doing so silently shows the wrong/empty roster
 * and writes SOUL.md/avatar cleanup into the wrong place.
 *
 * Contract:
 *   HVO_HERMES_ROOT   explicit fleet root (preferred). Path-only; never probed.
 *   HERMES_HOME       legacy fallback ONLY when it is not a named-profile home.
 *   ~/.hermes         last resort when neither variable is set.
 *
 * This module performs PATH ARITHMETIC ONLY. It does not read the real home
 * directory, does not stat anything, and does not repoint the default Hermes
 * install. CLI calls keep the ambient environment unless HVO_HERMES_ROOT is
 * explicitly set, but `fleetRootEnv` always validates the resolved root first
 * (see there).
 */
import os from 'node:os'
import path from 'node:path'

export class FleetRootScopeError extends Error {
  readonly code = 'fleet_root_misconfigured'
  constructor(message: string) {
    super(message)
    this.name = 'FleetRootScopeError'
  }
}

/**
 * True when a path is a named profile home (`<somewhere>/profiles/<name>`).
 * Path-only, so it works without touching the filesystem and in synthetic tests.
 */
export function looksLikeNamedProfileHome(p: string): boolean {
  const parts = path.resolve(p).split(path.sep).filter(Boolean)
  const i = parts.lastIndexOf('profiles')
  return i >= 0 && i < parts.length - 1
}

export type RootEnv = {
  HVO_HERMES_ROOT?: string
  HERMES_HOME?: string
  [key: string]: string | undefined
}

/**
 * Resolve the fleet root from an explicit environment snapshot.
 *
 * Throws a diagnostic (fail closed) when the only configured home is a named
 * profile home, or when HVO_HERMES_ROOT itself points at one. Nothing is
 * changed on disk — the caller must fix the launch environment or set
 * HVO_HERMES_ROOT to the actual install root explicitly.
 */
export function resolveFleetRoot(env: RootEnv = process.env, homeDir = os.homedir()): string {
  const explicit = (env.HVO_HERMES_ROOT || '').trim()
  if (explicit) {
    const resolved = path.resolve(explicit)
    if (looksLikeNamedProfileHome(resolved)) {
      throw new FleetRootScopeError(
        `HVO_HERMES_ROOT trỏ đến thư mục home của hồ sơ có tên (${explicit}) — đó không phải thư mục gốc của toàn bộ nhóm tác tử. ` +
          `Đặt HVO_HERMES_ROOT trỏ đến thư mục gốc cài đặt Hermes (ví dụ ~/.hermes). Không có tệp nào bị thay đổi.`,
      )
    }
    return resolved
  }

  const legacy = (env.HERMES_HOME || '').trim()
  if (legacy) {
    if (looksLikeNamedProfileHome(legacy)) {
      throw new FleetRootScopeError(
        `HERMES_HOME trỏ đến thư mục home của hồ sơ có tên (${legacy}) — đó không phải thư mục gốc của toàn bộ nhóm tác tử. ` +
          `Đặt HVO_HERMES_ROOT trỏ đến thư mục gốc cài đặt Hermes (ví dụ ~/.hermes), ` +
          `hoặc xóa giá trị HERMES_HOME. Không có tệp nào bị thay đổi.`,
      )
    }
    return path.resolve(legacy)
  }
  return path.join(homeDir, '.hermes')
}

/**
 * Environment for child Hermes CLI processes.
 *
 * The resolved root is validated BEFORE every CLI call, including when
 * HVO_HERMES_ROOT is absent: an ambient `HERMES_HOME=…/profiles/<name>` must
 * fail closed rather than be handed to the subprocess. When the operator
 * explicitly configured HVO_HERMES_ROOT, point the CLI at that root too, so
 * filesystem reads and CLI reads agree. Without that explicit variable the
 * ambient environment is left untouched — we never silently repoint an existing
 * Hermes install.
 */
export function fleetRootEnv<T extends RootEnv>(env: T): T {
  const out = { ...env }
  const explicit = (env.HVO_HERMES_ROOT || '').trim()
  // Throws FleetRootScopeError for a named-profile HVO_HERMES_ROOT or HERMES_HOME.
  const root = resolveFleetRoot(env)
  if (explicit) out.HERMES_HOME = root
  return out
}
