-- queue: ephemeral work queue (mutated, cleaned)
CREATE TABLE IF NOT EXISTS queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent         TEXT    NOT NULL,
  task          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running')),
  parent        TEXT,
  run_id        TEXT,
  pid           INTEGER,
  running_since TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON queue (status);

-- events: append-only lifecycle log (never mutated; carries the call tree)
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('started', 'finished', 'died')),
  ts      TEXT NOT NULL,
  agent   TEXT NOT NULL,
  task    TEXT NOT NULL,
  parent  TEXT,
  status  TEXT CHECK (status IS NULL OR status IN ('success', 'flagged', 'error')),
  cost    REAL,
  summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_run_id ON events (run_id);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_agent  ON events (agent);
CREATE INDEX IF NOT EXISTS idx_events_parent ON events (parent);

-- chat_messages: human↔harness conversation log + the chat agent's memory source.
-- Channel-agnostic; conversation_id/sender are opaque strings only the channel understands.
CREATE TABLE IF NOT EXISTS chat_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender          TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  text            TEXT NOT NULL,
  ts              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages (conversation_id, ts);

-- channel_state: per-channel poll cursor so the ingest adapter only reads new messages.
CREATE TABLE IF NOT EXISTS channel_state (
  channel TEXT PRIMARY KEY,
  cursor  TEXT
);

-- outbox: replies a (short-lived) worker validated but cannot deliver itself — the live channel
-- socket lives in the long-lived main process, which drains and sends these. Decouples the
-- per-run worker from the connection.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status);
