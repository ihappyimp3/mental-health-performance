-- 지표(계획서별 성과지표)
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  year        INTEGER NOT NULL,
  doc         TEXT NOT NULL,          -- 계획서 키 (main, district, dept, budget, audit, health, center, child, youth, rights)
  name        TEXT NOT NULL,          -- 지표명
  calc        TEXT NOT NULL DEFAULT '', -- 산출내역
  owner       TEXT NOT NULL DEFAULT '', -- 담당
  target      REAL NOT NULL DEFAULT 0,  -- 연간 목표
  unit        TEXT NOT NULL DEFAULT '',
  ord         INTEGER NOT NULL DEFAULT 0,
  copied_from TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_year_doc ON plans(year, doc);

-- 날짜별 실적
CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,           -- YYYY-MM-DD
  value      REAL NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_plan ON records(plan_id);
CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
