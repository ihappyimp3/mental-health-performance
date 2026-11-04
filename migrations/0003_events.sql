-- 전체 현황 캘린더의 일정(프로그램)
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  date       TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '',
  end_time   TEXT NOT NULL DEFAULT '',
  place      TEXT NOT NULL DEFAULT '',
  target     TEXT NOT NULL DEFAULT '',
  headcount  INTEGER,
  content    TEXT NOT NULL DEFAULT '',
  owner      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
