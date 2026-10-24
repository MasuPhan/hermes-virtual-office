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
 */
export function swr<T>(
  compute: () => Promise<T>,
  opts: { freshMs: number; maxStaleMs: number },
): () => Promise<T> {
  let cur: { value: T; at: number } | null = null
  let running: Promise<T> | null = null

  const refresh = (): Promise<T> => {
    if (!running) {
      running = compute()
        .then((value) => {
          cur = { value, at: Date.now() }
          return value
        })
        .finally(() => {
          running = null
        })
    }
    return running
  }

  return async () => {
    const age = cur ? Date.now() - cur.at : Infinity
    if (cur && age < opts.freshMs) return cur.value
    if (cur && age < opts.maxStaleMs) {
      void refresh().catch(() => {})
      return cur.value
    }
    return refresh()
  }
}
