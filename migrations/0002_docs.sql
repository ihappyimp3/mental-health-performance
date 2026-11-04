-- 계획서 목록을 코드가 아니라 DB로 관리한다 (추가·이름 수정 가능). 기본 10종을 넣어 둔다.
CREATE TABLE IF NOT EXISTS docs (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  ord        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO docs (key, name, ord, created_at) VALUES
  ('main',     '주요업무계획',     0, '2026-11-04T00:00:00.000Z'),
  ('district', '구정성과',         1, '2026-11-04T00:00:00.000Z'),
  ('dept',     '부서별 성과관리',  2, '2026-11-04T00:00:00.000Z'),
  ('budget',   '예산의 성과지표',  3, '2026-11-04T00:00:00.000Z'),
  ('audit',    '행정사무감사',     4, '2026-11-04T00:00:00.000Z'),
  ('health',   '지역보건의료계획', 5, '2026-11-04T00:00:00.000Z'),
  ('center',   '센터 계획서',      6, '2026-11-04T00:00:00.000Z'),
  ('child',    '아동정책계획',     7, '2026-11-04T00:00:00.000Z'),
  ('youth',    '청년정책계획',     8, '2026-11-04T00:00:00.000Z'),
  ('rights',   '인권계획',         9, '2026-11-04T00:00:00.000Z');
