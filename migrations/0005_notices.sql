-- 공지사항 게시판 (첨부파일은 base64 조각으로 D1에 저장: R2 없이 Cloudflare 계정 안에만 보관)
CREATE TABLE IF NOT EXISTS notices (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  pinned     INTEGER NOT NULL DEFAULT 0,
  views      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notices_order ON notices(pinned, created_at);
CREATE TABLE IF NOT EXISTS notice_files (
  id         TEXT PRIMARY KEY,
  notice_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notice_files_notice ON notice_files(notice_id);
CREATE TABLE IF NOT EXISTS notice_chunks (
  file_id TEXT NOT NULL,
  idx     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (file_id, idx)
);
