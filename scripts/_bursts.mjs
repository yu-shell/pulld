// Session grouping for the reward columns.
//
// `functions/_traffic.js` answers "who fetched this?" from the user-agent alone, which is all a
// single request can be asked. It cannot answer the question that has fooled this log five times
// now: *how many separate decisions* does a set of fetches represent. On 2026-08-15 one client in
// VN fetched 21 components in 0.222 seconds under a bare `shadcn` UA — a catalogue sweep that the
// per-request classifier is right to call an install client, and that the install column is wrong
// to report as 21 installs. It pushed the 30-day column from 10 to 31 and carried learn.mjs's
// reward gate over MIN_SIGNAL on nothing.
//
// So: group the log into client sessions, and say plainly which of them are one action rather
// than many. Kept in one place because report.mjs, learn.mjs and sweep.mjs have to agree about it
// for the same reason they share `isInstall` — three copies of a counting rule is how the loop
// starts optimising for scrapers.

/**
 * `npx shadcn add` resolves the package, fetches, and writes files before a person can type the
 * next one. Two seconds is far below that floor and far above any single client's own latency, so
 * a gap under it means nobody decided anything in between.
 */
const DEFAULT_GAP_MS = 2000

/** Three distinct components in one chain is a sweep; two can still be somebody adding a pair. */
const DEFAULT_MIN_ITEMS = 3

/**
 * Groups fetches into sessions of one client acting once.
 *
 * A session is a run of fetches from the same country and user-agent with no gap longer than
 * `gapMs`. Within a session a repeated item counts once — a retry is not a second install.
 * A session that touched `minItems` or more distinct components is marked a sweep: whatever it
 * is, it is one client walking the catalogue, not that many people choosing.
 *
 * @param {{ts: number|string, ua?: string, country?: string, item: string}[]} events
 * @returns {{sessions: object[], sweeps: object[], rawCount: number, collapsedCount: number}}
 */
export function groupSessions(events, options = {}) {
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS
  const minItems = options.minItems ?? DEFAULT_MIN_ITEMS

  const sorted = [...events]
    // `Number(null)` is 0, not NaN, so a row with no timestamp would otherwise be
    // filed at the epoch and chained to whatever else landed there.
    .map((e) => ({
      ...e,
      ts: e.ts === null || e.ts === undefined || e.ts === "" ? NaN : Number(e.ts),
    }))
    .filter((e) => Number.isFinite(e.ts))
    .sort((a, b) => {
      const client = key(a).localeCompare(key(b))
      return client !== 0 ? client : a.ts - b.ts
    })

  const sessions = []
  let open = null
  for (const event of sorted) {
    if (open && key(open) === key(event) && event.ts - open.last <= gapMs) {
      open.last = event.ts
      open.rows += 1
      open.items.add(event.item)
      continue
    }
    open = {
      ua: event.ua ?? "",
      country: event.country ?? "",
      first: event.ts,
      last: event.ts,
      rows: 1,
      items: new Set([event.item]),
    }
    sessions.push(open)
  }

  for (const session of sessions) {
    session.spanMs = session.last - session.first
    session.distinct = session.items.size
    session.sweep = session.distinct >= minItems
  }

  // A sweep is one decision; anything else is credited per distinct component it took.
  const collapsedCount = sessions.reduce(
    (sum, s) => sum + (s.sweep ? 1 : s.distinct),
    0
  )

  return {
    sessions,
    sweeps: sessions.filter((s) => s.sweep).sort((a, b) => b.rows - a.rows),
    rawCount: events.length,
    collapsedCount,
  }
}

// Joined on a character neither field can contain, so a user-agent that happens to
// begin with a space cannot be mistaken for a different country/UA split.
const key = (event) => `${event.country ?? ""}\u0000${event.ua ?? ""}`

/**
 * Per-component reward credit: one point per distinct component in a session that was somebody
 * choosing, and nothing at all for a sweep.
 *
 * A sweep is dropped rather than divided into fractions for the same reason `_traffic.js` drops
 * the `index` class outright — a client taking the whole catalogue says nothing about which
 * component was worth taking, so there is no share of it any one component has earned.
 */
export function creditSessions(events, options = {}) {
  const { sessions } = groupSessions(events, options)
  const byItem = {}
  let total = 0
  for (const session of sessions) {
    if (session.sweep) continue
    for (const item of session.items) {
      byItem[item] = (byItem[item] || 0) + 1
      total += 1
    }
  }
  return { byItem, total }
}

/** `2026-08-15` from an epoch-ms timestamp, in UTC — the same day boundary the log stores. */
export const utcDay = (ts) => new Date(Number(ts)).toISOString().slice(0, 10)

export const formatSpan = (ms) =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 0)}s`
