/**
 * schema.js — la structure de la base, appliquée toute seule.
 *
 * L'application ne doit pas dépendre d'une commande lancée à la main : si les
 * tables manquent, chaque requête échoue et l'invité ne voit qu'un message
 * d'incident. Le Worker vérifie donc la base au premier appel et la crée si
 * besoin. `schema.sql` est produit à partir d'ici (`npm run db:dump`) pour les
 * migrations manuelles.
 */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS contributors (
     id            TEXT PRIMARY KEY,
     slug          TEXT NOT NULL UNIQUE,
     first_name    TEXT NOT NULL,
     last_name     TEXT NOT NULL,
     display_name  TEXT NOT NULL,
     created_at    TEXT NOT NULL,
     last_seen_at  TEXT NOT NULL,
     media_count   INTEGER NOT NULL DEFAULT 0,
     bytes_total   INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS media (
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
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS media_dedup
     ON media (contributor_id, fingerprint)
     WHERE status IN ('pending','uploading','stored')`,

  `CREATE INDEX IF NOT EXISTS media_by_contributor ON media (contributor_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS media_by_status      ON media (status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS media_by_kind        ON media (kind, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS media_gallery        ON media (status, completed_at DESC)`,

  `CREATE TABLE IF NOT EXISTS rate_limit (
     bucket_key   TEXT PRIMARY KEY,
     count        INTEGER NOT NULL DEFAULT 0,
     window_start INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS rate_limit_window ON rate_limit (window_start)`,
];

/**
 * Colonnes ajoutées après coup. Une base créée par une version antérieure a
 * bien ses tables, mais pas ces colonnes-là : le contrôle d'existence des
 * tables ne suffirait donc pas, et chaque écriture échouerait.
 */
const MEDIA_COLUMNS = {
  thumb_key: 'TEXT',
  width: 'INTEGER',
  height: 'INTEGER',
  duration: 'REAL',
  stored_size: 'INTEGER',
};

let ready = false;

/**
 * Met la base en état : crée les tables absentes, ajoute les colonnes qui
 * manquent, et se rejoue si jamais la base venait à disparaître sous les pieds
 * du Worker (ce qui arrive en développement quand on efface l'état local).
 *
 * Coût en régime normal : une requête triviale au premier appel de l'instance.
 */
export async function ensureSchema(env) {
  if (ready) return;

  let tablesExist = false;
  try {
    await env.DB.prepare('SELECT id FROM contributors LIMIT 1').first();
    tablesExist = true;
  } catch {
    tablesExist = false;
  }

  if (!tablesExist) {
    for (const statement of SCHEMA) await env.DB.prepare(statement).run();
    ready = true;
    console.log('[ouistitii] base créée');
    return;
  }

  // Les tables sont là : reste à vérifier qu'elles sont à jour.
  const { results } = await env.DB.prepare('PRAGMA table_info(media)').all();
  const present = new Set(results.map((c) => c.name));
  const missing = Object.entries(MEDIA_COLUMNS).filter(([name]) => !present.has(name));

  for (const [name, type] of missing) {
    await env.DB.prepare(`ALTER TABLE media ADD COLUMN ${name} ${type}`).run();
  }
  if (missing.length) {
    console.log(`[ouistitii] base mise à jour : ${missing.map(([n]) => n).join(', ')}`);
  }

  ready = true;
}

/**
 * À appeler quand une requête échoue de façon inattendue : la prochaine
 * requête revérifiera la base au lieu de se fier à un état devenu faux.
 */
export function invalidateSchema() {
  ready = false;
}
