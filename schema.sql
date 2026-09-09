-- ═══════════════════════════════════════════════════════════════
-- OUISTITII par T&F — schéma D1
-- Fichier ENGENDRÉ depuis worker/schema.js (npm run db:dump) : ne pas
-- le modifier à la main. Le Worker applique ce schéma tout seul au premier
-- démarrage ; ce fichier ne sert qu'aux migrations manuelles.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS contributors (
    id            TEXT PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    media_count   INTEGER NOT NULL DEFAULT 0,
    bytes_total   INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE IF NOT EXISTS media (
    id             TEXT PRIMARY KEY,
    contributor_id TEXT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
    session_id     TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('photo','video')),
    mime           TEXT NOT NULL,
    ext            TEXT NOT NULL,
    size           INTEGER NOT NULL,
    stored_size    INTEGER,
    original_name  TEXT,
    storage_key    TEXT NOT NULL UNIQUE,
    fingerprint    TEXT NOT NULL,
    source         TEXT NOT NULL DEFAULT 'gallery' CHECK (source IN ('camera','gallery')),
    taken_at       TEXT,
    thumb_key      TEXT,
    width          INTEGER,
    height         INTEGER,
    duration       REAL,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','uploading','stored','failed','rejected','deleted')),
    upload_id      TEXT,
    part_size      INTEGER,
    parts_total    INTEGER,
    error          TEXT,
    created_at     TEXT NOT NULL,
    completed_at   TEXT
  );

CREATE UNIQUE INDEX IF NOT EXISTS media_dedup
    ON media (contributor_id, fingerprint)
    WHERE status IN ('pending','uploading','stored');

CREATE INDEX IF NOT EXISTS media_by_contributor ON media (contributor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS media_by_status      ON media (status, created_at DESC);

CREATE INDEX IF NOT EXISTS media_by_kind        ON media (kind, created_at DESC);

CREATE INDEX IF NOT EXISTS media_gallery        ON media (status, completed_at DESC);

CREATE TABLE IF NOT EXISTS rate_limit (
    bucket_key   TEXT PRIMARY KEY,
    count        INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS rate_limit_window ON rate_limit (window_start);
