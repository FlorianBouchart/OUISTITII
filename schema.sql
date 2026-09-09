-- ═══════════════════════════════════════════════════════════════
-- OUISTITII par T&F — schéma D1 (métadonnées ; les fichiers vivent dans R2)
-- Appliquer :  npm run db:migrate         (local)
--              npm run db:migrate:remote  (production)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS contributors (
  id            TEXT PRIMARY KEY,           -- uuid v4
  slug          TEXT NOT NULL UNIQUE,       -- prenom-nom (normalisé, sans accents)
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  display_name  TEXT NOT NULL,              -- "Prénom Nom" tel qu'affiché
  created_at    TEXT NOT NULL,              -- ISO 8601 UTC
  last_seen_at  TEXT NOT NULL,
  media_count   INTEGER NOT NULL DEFAULT 0, -- médias effectivement stockés
  bytes_total   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS media (
  id             TEXT PRIMARY KEY,          -- uuid v4, sert aussi dans la clé R2
  contributor_id TEXT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL,             -- une "session" = une visite de l'app
  kind           TEXT NOT NULL CHECK (kind IN ('photo','video')),
  mime           TEXT NOT NULL,
  ext            TEXT NOT NULL,
  size           INTEGER NOT NULL,          -- taille annoncée par le client
  stored_size    INTEGER,                   -- taille réellement constatée dans R2
  original_name  TEXT,
  storage_key    TEXT NOT NULL UNIQUE,      -- chemin complet dans le bucket
  fingerprint    TEXT NOT NULL,             -- empreinte anti-doublon (par contributeur)
  source         TEXT NOT NULL DEFAULT 'gallery' CHECK (source IN ('camera','gallery')),
  taken_at       TEXT,                      -- date du fichier côté téléphone
  thumb_key      TEXT,                      -- vignette pour la galerie partagée
  width          INTEGER,
  height         INTEGER,
  duration       REAL,                      -- secondes, pour les vidéos
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','uploading','stored','failed','rejected','deleted')),
  upload_id      TEXT,                      -- multipart S3 en cours
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
-- La galerie partagée lit toujours « les souvenirs arrivés, du plus récent au plus ancien ».
CREATE INDEX IF NOT EXISTS media_gallery         ON media (status, completed_at DESC);

-- Garde-fou anti-abus : compteurs par fenêtre glissante
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket_key   TEXT PRIMARY KEY,            -- "<scope>:<identifiant>:<fenêtre>"
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL             -- epoch secondes
);
CREATE INDEX IF NOT EXISTS rate_limit_window ON rate_limit (window_start);
