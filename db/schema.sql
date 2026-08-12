-- Fetch log: one row each time a registry item is fetched via the CLI/MCP.
-- Used to measure which components are being installed.
CREATE TABLE IF NOT EXISTS fetches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
  item TEXT NOT NULL,        -- registry item name (e.g. copy-button)
  ts INTEGER NOT NULL,       -- epoch ms
  ua TEXT,                   -- user-agent (first 256 chars)
  country TEXT,              -- cf-ipcountry
  is_bot INTEGER DEFAULT 0   -- 1 for a clear automated user-agent (excluded when reading)
);
CREATE INDEX IF NOT EXISTS idx_fetches_item ON fetches(item);
CREATE INDEX IF NOT EXISTS idx_fetches_date ON fetches(date);

-- Names asked for under /r/<name>.json that this registry has never shipped. Kept OUT of
-- `fetches` on purpose: a miss is not a delivered component, and `fetches` is the reward
-- learn.mjs tunes against. They are still the most direct answer to "what do agents come here
-- looking for?" — the daily routine picks the next component partly from this list.
--
-- Until 2026-08-09 misses were unreadable for the opposite reason: with no 404.html, Pages
-- substituted index.html under status 200, so every miss landed in `fetches` as a delivery.
-- Returning a real JSON 404 fixed the reward but blanked the signal — nothing was recorded at
-- all. This table is where the signal lives now, with the two roles finally separated.
CREATE TABLE IF NOT EXISTS misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
  item TEXT NOT NULL,        -- the name that was asked for and does not exist
  ts INTEGER NOT NULL,       -- epoch ms
  ua TEXT,                   -- user-agent (first 256 chars)
  country TEXT,              -- cf-ipcountry
  is_bot INTEGER DEFAULT 0   -- 1 for a clear automated user-agent
);
CREATE INDEX IF NOT EXISTS idx_misses_date ON misses(date);

-- Buy-button clicks (functions/go/[target].js), recorded before the redirect to Polar. Polar
-- opens a new Checkout Session on every visit to a checkout link, so its checkout count can't
-- tell a buyer from a crawler that followed the link; this is the funnel's real denominator.
CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
  target TEXT NOT NULL,      -- 'search' | 'pro'
  ts INTEGER NOT NULL,       -- epoch ms
  ua TEXT,                   -- user-agent (first 256 chars)
  country TEXT,              -- cf-ipcountry
  referer TEXT,              -- where the click came from (first 256 chars)
  is_bot INTEGER DEFAULT 0   -- 1 = crawler; these are shown the link instead of being redirected
);
CREATE INDEX IF NOT EXISTS idx_clicks_date ON clicks(date);

-- License keys for Pro blocks (one key per one-time purchase, issued by the checkout webhook).
CREATE TABLE IF NOT EXISTS licenses (
  key TEXT PRIMARY KEY,
  email TEXT,
  product TEXT,
  created TEXT,
  active INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',   -- 'active' | 'refunded' (terminal) | 'disabled'
  test_mode INTEGER DEFAULT 0     -- 1 = test-mode purchase; the gate only accepts test_mode=0/NULL
);

-- Webhook audit log: signature pass/fail, event name, and outcome. For verification and monitoring.
CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  event TEXT,
  ok INTEGER,
  note TEXT
);

-- pulld Search (semantic search service). One project per customer = one Vectorize namespace.
-- admin_key indexes content (secret); query_key is used client-side to search (Algolia-style).
CREATE TABLE IF NOT EXISTS search_projects (
  id TEXT PRIMARY KEY,
  admin_key TEXT UNIQUE,
  query_key TEXT UNIQUE,
  email TEXT,
  -- The customer's license key = their retrieval token, and the subscription it came from. Both
  -- are written by functions/api/polar-webhook.js and hold Polar values. The `ls_` prefix is
  -- historical: billing started on Lemon Squeezy, and renaming a column that live rows are keyed
  -- on (ON CONFLICT(ls_license), and /account's lookup) needs a D1 migration these comments are
  -- not worth. Read `ls_` as "license source", not as the vendor.
  ls_license TEXT UNIQUE,         -- Polar license key = the customer's retrieval token
  ls_subscription TEXT,           -- Polar subscription/order id (best-effort, for lifecycle)
  plan TEXT DEFAULT 'free',
  q_limit INTEGER DEFAULT 1000,   -- queries per month
  doc_limit INTEGER DEFAULT 200,  -- indexed docs
  created TEXT,
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS search_usage (
  project TEXT,
  month TEXT,                     -- YYYY-MM
  queries INTEGER DEFAULT 0,
  docs INTEGER DEFAULT 0,
  PRIMARY KEY (project, month)
);

-- Short-window burst rate limiting for the public search query_key. One row per (key, bucket),
-- where key = "<project>:<ip>" and bucket = floor(epoch_seconds / window). Stale buckets are
-- pruned opportunistically by the query path.
CREATE TABLE IF NOT EXISTS rate_limits (
  k TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, bucket)
);
