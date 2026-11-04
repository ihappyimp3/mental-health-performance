-- 일정: 팀명, 종료일 추가 (기존 date = 시작일)
ALTER TABLE events ADD COLUMN team TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN end_date TEXT NOT NULL DEFAULT '';
