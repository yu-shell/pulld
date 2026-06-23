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
