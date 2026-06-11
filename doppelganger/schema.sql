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
