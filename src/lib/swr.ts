/**
 * Stale-while-revalidate for slow server reads.
 *
 * Behind several office endpoints sit Hermes CLI calls of ~1.2 s each (one Python process per
 * call), and the client polls them together: a tick waits for its SLOWEST answer, so one slow
 * read slows every refresh. This keeps the last answer and serves it at once while a single
 * refresh runs in the background:
 *
 * - younger than `freshMs`            → return it, do nothing;
 * - older, but within `maxStaleMs`    → return it NOW, start one background refresh;
 * - missing or older than `maxStaleMs` → wait for a refresh (errors reach the caller).
 *
 * Concurrent callers share the one refresh. A failed background refresh is dropped: the stale
 * answer keeps being served until `maxStaleMs`, after which the error surfaces.
 *
 * `version` (optional) names the state the answer was computed from. When it has changed (a
 * write happened), the stored answer is NOT served stale: the caller waits for a fresh one, so
 * an action the operator just took is never hidden behind an old answer.
 */
export function swr<T>(
  compute: () => Promise<T>,
  opts: { freshMs: number; maxStaleMs: number; version?: () => unknown },
): () => Promise<T> {
  let cur: { value: T; at: number; ver: unknown } | null = null
  let running: { p: Promise<T>; ver: unknown } | null = null
  let latest = 0

  const refresh = (): Promise<T> => {
    const ver = opts.version?.()
    // A refresh that STARTED before a write answers for the old state: never share it.
    if (running && running.ver === ver) return running.p
    const mine = ++latest
    const p = compute()
      .then((value) => {
        // An older refresh finishing after a newer one must not overwrite it.
        if (mine === latest) cur = { value, at: Date.now(), ver }
        return value
      })
      .finally(() => {
        if (running?.p === p) running = null
      })
    running = { p, ver }
    return p
  }

  return async () => {
    if (cur && opts.version && cur.ver !== opts.version()) cur = null
    const age = cur ? Date.now() - cur.at : Infinity
    if (cur && age < opts.freshMs) return cur.value
    if (cur && age < opts.maxStaleMs) {
      void refresh().catch(() => {})
      return cur.value
    }
    return refresh()
  }
}
