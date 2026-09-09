/**
 * media.js — le parcours d'un souvenir, de l'écran d'ajout jusqu'à R2.
 *
 *   1. /api/session          l'invité se nomme, une session signée s'ouvre
 *   2. /api/media/check      on écarte ce qu'il a déjà envoyé (anti-doublon)
 *   3. /api/media/init       une place est réservée : ligne en base + URL signée
 *   4. le fichier part vers R2 (directement, ou par relais en développement)
 *   5. /api/media/:id/complete   clôture, puis vérification de la taille écrite
 */

import {
  json, bad, slugify, titleCase, safeName, uuid, nowISO,
  describeMime, magicMatches, rateLimit, clientIp,
} from './util.js';
import { issueGuestToken, requireGuest, sessionCookie } from './auth.js';
import {
  storageMode, beginUpload, signPartUrls, finishUpload, abortUpload,
  relayPut, relayPart, headObject, getObject, deleteObject, partSizeOf, multipartThreshold,
  driveChunk, putThumbObject,
} from './storage.js';

const maxFileBytes = (env) => Number(env.MAX_FILE_MB || 600) * 1024 * 1024;

/** Plafond de stockage, au-delà duquel plus rien n'entre. 0 = pas de plafond. */
const storageLimit = (env) => Number(env.STORAGE_LIMIT_GB || 0) * 1024 * 1024 * 1024;

/**
 * Ce qui est déjà stocké, tout contributeur confondu.
 * On additionne aussi ce qui est en cours d'envoi : sans cela, dix téléphones
 * qui déposent en même temps pourraient franchir le plafond ensemble.
 */
async function usedBytes(env) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(COALESCE(stored_size, size)), 0) AS total
       FROM media WHERE status IN ('stored','uploading','pending')`
  ).first();
  return Number(row?.total || 0);
}

/**
 * Le verrou. Il ne s'agit pas d'une optimisation : c'est la garantie qu'aucune
 * facture ne peut apparaître. L'album reste consultable et téléchargeable —
 * seuls les nouveaux envois sont refusés.
 */
async function assertRoom(env, incoming) {
  const limit = storageLimit(env);
  if (!limit) return;

  const used = await usedBytes(env);
  if (used + incoming <= limit) return;

  throw bad(
    'storage_full',
    'L’album a atteint sa capacité : les souvenirs déjà envoyés restent ' +
      'consultables et téléchargeables, mais il n’est plus possible d’en ajouter. ' +
      'Prévenez les mariés, ils feront de la place.',
    507
  );
}

/** État du stockage, pour l'afficher aux mariés et prévenir avant le plafond. */
export async function storageState(env) {
  const limit = storageLimit(env);
  const used = await usedBytes(env);
  return {
    used,
    limit,
    free: limit ? Math.max(limit - used, 0) : null,
    ratio: limit ? Math.min(used / limit, 1) : 0,
    full: limit ? used >= limit : false,
  };
}

/* ═══════════════════════════════════════════════════════════════
   1. SESSION — prénom + nom, rien de plus
   ═══════════════════════════════════════════════════════════════ */

export async function openSession(request, env) {
  const body = await readJson(request);
  const firstName = titleCase(body.firstName || '');
  const lastName = titleCase(body.lastName || '');

  if (firstName.length < 2 || lastName.length < 1) {
    throw bad('name_required', 'Merci d’indiquer votre prénom et votre nom.');
  }
  if (firstName.length > 40 || lastName.length > 40) {
    throw bad('name_too_long', 'Ce nom est un peu long — abrégez-le.');
  }

  await rateLimit(env.DB, 'session', await hashIp(request), 30, 600);

  const slug = slugify(`${firstName}-${lastName}`);
  if (!slug) throw bad('name_invalid', 'Merci d’indiquer votre prénom et votre nom.');

  const displayName = `${firstName} ${lastName}`;
  const now = nowISO();

  // Un même invité qui revient retrouve son dossier : ses médias restent groupés.
  await env.DB.prepare(
    `INSERT INTO contributors (id, slug, first_name, last_name, display_name, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(slug) DO UPDATE SET last_seen_at = ?6, display_name = ?5`
  ).bind(uuid(), slug, firstName, lastName, displayName, now).run();

  const contributor = await env.DB.prepare(
    'SELECT id, slug, display_name, media_count FROM contributors WHERE slug = ?1'
  ).bind(slug).first();

  const sessionId = uuid();
  const token = await issueGuestToken(env, contributor.id, sessionId);

  return json(
    {
      token,
      sessionId,
      contributor: {
        id: contributor.id,
        slug: contributor.slug,
        displayName: contributor.display_name,
        mediaCount: contributor.media_count,
      },
      config: {
        maxFileBytes: maxFileBytes(env),
        partSize: partSizeOf(env),
        multipartThreshold: multipartThreshold(env),
        transport: storageMode(env),
        acceptedTypes: 'image/*,video/*',
        availableUntil: env.AVAILABLE_UNTIL || null,
        storage: await storageState(env),
      },
    },
    200,
    { 'set-cookie': sessionCookie(token) }
  );
}

/* ═══════════════════════════════════════════════════════════════
   2. ANTI-DOUBLON — avant même d'ajouter à la file
   ═══════════════════════════════════════════════════════════════ */

export async function checkFingerprints(request, env) {
  const { cid } = await requireGuest(request, env);
  const body = await readJson(request);
  const fingerprints = Array.isArray(body.fingerprints) ? body.fingerprints.slice(0, 300) : [];
  if (!fingerprints.length) return json({ known: [] });

  const placeholders = fingerprints.map((_, i) => `?${i + 2}`).join(',');
  const { results } = await env.DB.prepare(
    `SELECT fingerprint FROM media
      WHERE contributor_id = ?1 AND status = 'stored' AND fingerprint IN (${placeholders})`
  ).bind(cid, ...fingerprints).all();

  return json({ known: results.map((r) => r.fingerprint) });
}

/* ═══════════════════════════════════════════════════════════════
   3. INIT — réservation d'une place et d'une URL signée
   ═══════════════════════════════════════════════════════════════ */

export async function initUpload(request, env) {
  const { cid, sid } = await requireGuest(request, env);
  const body = await readJson(request);

  const size = Number(body.size);
  const mime = String(body.mime || '').toLowerCase();
  const fingerprint = String(body.fingerprint || '').slice(0, 128);

  if (!Number.isFinite(size) || size <= 0) throw bad('size_invalid', 'Fichier illisible.');
  if (size > maxFileBytes(env)) {
    throw bad(
      'file_too_large',
      `Ce fichier dépasse ${env.MAX_FILE_MB} Mo. Envoyez une version plus courte.`,
      413
    );
  }
  if (!fingerprint) throw bad('fingerprint_required', 'Fichier illisible.');

  const { kind, ext } = describeMime(mime);

  // Le média part droit vers R2 : c'est ici, sur ses premiers octets, qu'on
  // vérifie qu'une « photo » en est bien une.
  if (!magicMatches(mime, body.head)) {
    throw bad('content_mismatch', 'Ce fichier ne semble pas être une photo ou une vidéo.', 415);
  }

  await rateLimit(env.DB, 'init', cid, 400, 600);
  await assertRoom(env, size);

  const contributor = await env.DB.prepare(
    'SELECT id, slug, display_name FROM contributors WHERE id = ?1'
  ).bind(cid).first();
  if (!contributor) throw bad('session_expired', 'Session introuvable. Indiquez à nouveau votre nom.', 401);

  // Déjà stocké → on le dit, sans rien réécrire.
  const stored = await env.DB.prepare(
    `SELECT id FROM media WHERE contributor_id = ?1 AND fingerprint = ?2 AND status = 'stored'`
  ).bind(cid, fingerprint).first();
  if (stored) return json({ duplicate: true, mediaId: stored.id });

  // Envoi interrompu → on reprend la même place plutôt que d'en créer une autre.
  const pending = await env.DB.prepare(
    `SELECT * FROM media WHERE contributor_id = ?1 AND fingerprint = ?2
        AND status IN ('pending','uploading') LIMIT 1`
  ).bind(cid, fingerprint).first();

  if (pending && pending.size === size) {
    const resumed = await resumeDescriptor(env, pending);
    if (resumed) return json(resumed);
    await abortUpload(env, {
      key: pending.storage_key,
      uploadId: pending.upload_id,
      transport: storageMode(env),
    });
    await env.DB.prepare(`UPDATE media SET status='failed', error='reprise impossible' WHERE id=?1`)
      .bind(pending.id).run();
  }

  const mediaId = uuid();
  const key = buildKey(env, { contributor, kind, ext, mediaId, name: body.name, takenAt: body.takenAt });

  const upload = await beginUpload(env, {
    key, contentType: mime, size, kind, contributor,
  });

  await env.DB.prepare(
    `INSERT INTO media
       (id, contributor_id, session_id, kind, mime, ext, size, original_name, storage_key,
        fingerprint, source, taken_at, width, height, duration,
        status, upload_id, part_size, parts_total, session_url, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'pending',?16,?17,?18,?19,?20)`
  ).bind(
    mediaId, cid, sid, kind, mime, ext, size,
    String(body.name || '').slice(0, 160), key, fingerprint,
    body.source === 'camera' ? 'camera' : 'gallery',
    body.takenAt ? String(body.takenAt).slice(0, 40) : null,
    posInt(body.width), posInt(body.height), posNum(body.duration),
    upload.uploadId || null, upload.partSize || null, upload.partsTotal || null,
    upload.sessionUrl || null, nowISO()
  ).run();

  return json({
    mediaId,
    kind,
    ...describeUpload(upload, mediaId),
  });
}

/** Reconstitue de quoi reprendre un envoi fractionné laissé en plan. */
async function resumeDescriptor(env, row) {
  if (!row.upload_id) {
    // Fichier d'une seule pièce : on refabrique simplement l'URL.
    const upload = await beginUpload(env, {
      key: row.storage_key,
      contentType: row.mime,
      size: row.size,
    });
    return { mediaId: row.id, kind: row.kind, resumed: true, ...describeUpload(upload, row.id) };
  }
  const urls = await signPartUrls(
    env, row.storage_key, row.upload_id,
    Array.from({ length: Math.min(row.parts_total, 12) }, (_, i) => i + 1)
  );
  return {
    mediaId: row.id,
    kind: row.kind,
    resumed: true,
    transport: storageMode(env),
    multipart: true,
    partSize: row.part_size,
    partsTotal: row.parts_total,
    urls: urls || undefined,
    relayBase: urls ? undefined : `/api/relay/${row.id}`,
  };
}

function describeUpload(upload, mediaId) {
  return {
    transport: upload.transport,
    multipart: upload.multipart,
    ...(upload.multipart
      ? {
          partSize: upload.partSize,
          partsTotal: upload.partsTotal,
          urls: upload.urls || undefined,
          relayBase: upload.urls ? undefined : `/api/relay/${mediaId}`,
        }
      : { url: upload.url || undefined, relayBase: upload.url ? undefined : `/api/relay/${mediaId}` }),
  };
}

/**
 * Clé de stockage — lisible par un humain qui ouvrirait le bucket :
 *   mariage/2026-12-12/photos/marie-dupont/20261212-201455__a1b2c3d4__IMG_4821.jpg
 * L'identifiant court écarte toute collision entre deux fichiers homonymes.
 */
function buildKey(env, { contributor, kind, ext, mediaId, name, takenAt }) {
  const date = new Date(takenAt && !Number.isNaN(Date.parse(takenAt)) ? takenAt : Date.now());
  const stamp =
    date.toISOString().slice(0, 10).replace(/-/g, '') +
    '-' +
    date.toISOString().slice(11, 19).replace(/:/g, '');
  const prefix = env.EVENT_PREFIX || 'mariage';
  const eventDate = env.EVENT_DATE || '2026-12-12';
  return `${prefix}/${eventDate}/${kind}s/${contributor.slug}/${stamp}__${mediaId.slice(0, 8)}__${safeName(name)}.${ext}`;
}

/* ═══════════════════════════════════════════════════════════════
   4. PARTIES SUPPLÉMENTAIRES — pour les fichiers longs
   ═══════════════════════════════════════════════════════════════ */

export async function morePartUrls(request, env, mediaId) {
  const { cid } = await requireGuest(request, env);
  const row = await ownedMedia(env, cid, mediaId);
  const body = await readJson(request);
  const wanted = (Array.isArray(body.partNumbers) ? body.partNumbers : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= (row.parts_total || 1))
    .slice(0, 24);

  if (!row.upload_id || !wanted.length) return json({ urls: {} });

  await env.DB.prepare(`UPDATE media SET status='uploading' WHERE id=?1 AND status='pending'`)
    .bind(mediaId).run();

  const urls = await signPartUrls(env, row.storage_key, row.upload_id, wanted);
  return json({ urls: urls || {}, relayBase: urls ? undefined : `/api/relay/${mediaId}` });
}

/* ═══════════════════════════════════════════════════════════════
   5. CLÔTURE — et vérification de ce qui a réellement été écrit
   ═══════════════════════════════════════════════════════════════ */

export async function completeUpload(request, env, mediaId) {
  const { cid } = await requireGuest(request, env);
  const row = await ownedMedia(env, cid, mediaId);
  if (row.status === 'stored') return json({ ok: true, alreadyStored: true });

  const body = await readJson(request);
  const parts = Array.isArray(body.parts)
    ? body.parts
        .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag || '') }))
        .filter((p) => p.partNumber >= 1 && p.etag)
    : [];

  // Drive assemble lui-même à mesure : il n'y a rien à recomposer.
  if (row.upload_id && !row.session_url) {
    if (parts.length !== row.parts_total) {
      throw bad('parts_missing', 'L’envoi est incomplet — il va reprendre tout seul.', 409);
    }
    await finishUpload(env, {
      key: row.storage_key,
      uploadId: row.upload_id,
      parts,
      transport: storageMode(env),
    });
  }

  // Le client annonce une taille ; c'est le stockage qui tranche.
  const fresh = await env.DB.prepare('SELECT remote_id FROM media WHERE id = ?1').bind(mediaId).first();
  const head = await headObject(env, row.storage_key, fresh?.remote_id);
  if (!head) {
    await markFailed(env, mediaId, 'objet absent après clôture');
    throw bad('upload_incomplete', 'L’envoi n’est pas allé au bout. Réessayez.', 409);
  }
  if (head.size > maxFileBytes(env) || (row.size && Math.abs(head.size - row.size) > 1024)) {
    await deleteObject(env, row.storage_key, fresh?.remote_id);
    await env.DB.prepare(
      `UPDATE media SET status='rejected', error='taille inattendue', stored_size=?2 WHERE id=?1`
    ).bind(mediaId, head.size).run();
    throw bad('size_mismatch', 'Ce fichier a été modifié pendant l’envoi. Réessayez.', 409);
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE media SET status='stored', stored_size=?2, completed_at=?3,
              upload_id=NULL, session_url=NULL, error=NULL
        WHERE id=?1`
    ).bind(mediaId, head.size, nowISO()),
    env.DB.prepare(
      `UPDATE contributors
          SET media_count = media_count + 1,
              bytes_total = bytes_total + ?2,
              last_seen_at = ?3
        WHERE id = ?1`
    ).bind(cid, head.size, nowISO()),
  ]);

  return json({ ok: true, size: head.size });
}

export async function failUpload(request, env, mediaId) {
  const { cid } = await requireGuest(request, env);
  const row = await ownedMedia(env, cid, mediaId);
  const body = await readJson(request).catch(() => ({}));

  if (body.abandon) {
    await abortUpload(env, {
      key: row.storage_key,
      uploadId: row.upload_id,
      transport: storageMode(env),
    });
    await env.DB.prepare(`DELETE FROM media WHERE id=?1 AND status <> 'stored'`).bind(mediaId).run();
    return json({ ok: true, removed: true });
  }

  await markFailed(env, mediaId, String(body.error || 'envoi interrompu').slice(0, 200));
  return json({ ok: true });
}

const markFailed = (env, mediaId, error) =>
  env.DB.prepare(`UPDATE media SET status='failed', error=?2 WHERE id=?1 AND status <> 'stored'`)
    .bind(mediaId, error).run();

/* ═══════════════════════════════════════════════════════════════
   6. RELAIS — chemin de secours / développement
   ═══════════════════════════════════════════════════════════════ */

export async function relayUpload(request, env, mediaId, partNumber) {
  const { cid } = await requireGuest(request, env);
  const row = await ownedMedia(env, cid, mediaId);
  if (row.status === 'stored') throw bad('already_stored', 'Ce souvenir est déjà arrivé.', 409);

  await env.DB.prepare(`UPDATE media SET status='uploading' WHERE id=?1 AND status='pending'`)
    .bind(mediaId).run();

  // Vers Google Drive : chaque tranche est placée à son octet exact. Google
  // répond 308 tant qu'il en attend, et livre l'identifiant du fichier à la
  // dernière. Les octets traversent le Worker par tranches de quelques mégas,
  // bien au-dessous de toutes les limites du plan gratuit.
  if (row.session_url) {
    const n = Math.max(Number(partNumber) || 1, 1);
    const partSize = row.part_size || multipartThreshold(env);
    const start = (n - 1) * partSize;
    const end = Math.min(start + partSize, row.size) - 1;

    const result = await driveChunk(env, {
      sessionUrl: row.session_url,
      body: request.body,
      start,
      end,
      total: row.size,
    });

    if (result.done) {
      await env.DB.prepare('UPDATE media SET remote_id = ?2 WHERE id = ?1')
        .bind(mediaId, result.id).run();
    }
    return json({ etag: result.id || `part-${n}`, partNumber: n, done: result.done });
  }

  if (row.upload_id) {
    const n = Number(partNumber);
    if (!Number.isInteger(n) || n < 1 || n > row.parts_total) {
      throw bad('part_invalid', 'Envoi interrompu — il va reprendre.', 400);
    }
    const { etag } = await relayPart(env, {
      key: row.storage_key,
      uploadId: row.upload_id,
      partNumber: n,
      body: request.body,
    });
    return json({ etag, partNumber: n });
  }

  const { etag } = await relayPut(env, {
    key: row.storage_key,
    contentType: row.mime,
    body: request.body,
  });
  return json({ etag });
}

/* ═══════════════════════════════════════════════════════════════
   7. VIGNETTE — envoyée par le téléphone, qui l'a déjà fabriquée
   ═══════════════════════════════════════════════════════════════ */

const MAX_THUMB_BYTES = 260 * 1024;

/**
 * Le téléphone a produit une miniature pour sa propre file d'attente : on la
 * récupère telle quelle. Aucun redimensionnement côté serveur, aucun service
 * d'images à payer — et la galerie s'ouvre sans télécharger les originaux.
 */
export async function putThumb(request, env, mediaId) {
  const { cid } = await requireGuest(request, env);
  const row = await ownedMedia(env, cid, mediaId);

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_THUMB_BYTES) throw bad('thumb_too_large', 'Aperçu trop lourd.', 413);

  // Une vignette ne se dépose qu'une fois : un souvenir arrivé ne se retouche
  // plus, pas même par la petite porte de son aperçu.
  if (row.thumb_key) throw bad('thumb_locked', 'Cet aperçu est déjà enregistré.', 409);

  const key = `${env.EVENT_PREFIX || 'mariage'}/${env.EVENT_DATE || '2026-12-12'}/apercus/${mediaId}.jpg`;
  const saved = await putThumbObject(env, {
    key,
    body: request.body,
    contentType: 'image/jpeg',
    kind: row.kind,
  });
  if (!saved.ok) throw bad('thumb_failed', 'Aperçu non enregistré.', 500);

  await env.DB.prepare('UPDATE media SET thumb_key = ?2, remote_thumb = ?3 WHERE id = ?1')
    .bind(mediaId, key, saved.id || null).run();
  return json({ ok: true });
}

/* ═══════════════════════════════════════════════════════════════
   8. GALERIE PARTAGÉE — tout le monde regarde, personne ne retouche
   ═══════════════════════════════════════════════════════════════ */

/**
 * Les souvenirs de tous les invités, du plus récent au plus ancien.
 * Chaque entrée porte `mine` : seul son auteur verra le bouton de retrait.
 */
export async function listGallery(request, env, url) {
  const { cid } = await requireGuest(request, env);

  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 48), 1), 96);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
  const filter = url.searchParams.get('filter');

  const where = ["m.status = 'stored'"];
  const binds = [];
  if (filter === 'mine') { binds.push(cid); where.push(`m.contributor_id = ?${binds.length}`); }
  else if (filter === 'photo' || filter === 'video') {
    binds.push(filter); where.push(`m.kind = ?${binds.length}`);
  }

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.kind, m.width, m.height, m.duration, m.completed_at,
            m.stored_size, m.thumb_key IS NOT NULL AS has_thumb,
            m.contributor_id, c.display_name, c.first_name
       FROM media m JOIN contributors c ON c.id = m.contributor_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.completed_at DESC
      LIMIT ${limit} OFFSET ${offset}`
  ).bind(...binds).all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN kind='photo' THEN 1 ELSE 0 END) AS photos
       FROM media WHERE status='stored'`
  ).first();

  return json({
    items: results.map((r) => ({
      id: r.id,
      kind: r.kind,
      width: r.width,
      height: r.height,
      duration: r.duration,
      bytes: r.stored_size,
      at: r.completed_at,
      author: r.display_name,
      authorFirst: r.first_name,
      hasThumb: Boolean(r.has_thumb),
      mine: r.contributor_id === cid,
    })),
    offset,
    limit,
    total: total?.n || 0,
    photos: total?.photos || 0,
    videos: (total?.n || 0) - (total?.photos || 0),
  });
}

/** Aperçu ou original. Le seau reste privé : tout passe par ici, session en main. */
export async function serveMedia(request, env, mediaId, variant) {
  // Les invités y accèdent avec leur session ; les mariés avec la leur.
  await requireGuest(request, env).catch(async (error) => {
    const { requireAdmin } = await import('./auth.js');
    return requireAdmin(request, env).catch(() => { throw error; });
  });

  const row = await env.DB.prepare(
    `SELECT storage_key, thumb_key, remote_id, remote_thumb, mime, status
       FROM media WHERE id = ?1`
  ).bind(mediaId).first();
  if (!row || row.status !== 'stored') throw bad('media_unknown', 'Souvenir introuvable.', 404);

  const wantsThumb = variant === 'thumb' && row.thumb_key;
  const key = wantsThumb ? row.thumb_key : row.storage_key;
  const remote = wantsThumb ? row.remote_thumb : row.remote_id;

  const object = await getObject(env, key, remote);
  if (!object) throw bad('media_missing', 'Fichier absent.', 404);

  const headers = new Headers();
  headers.set('content-type', wantsThumb ? 'image/jpeg' : row.mime || 'application/octet-stream');
  headers.set('content-length', String(object.size));
  // Un souvenir envoyé ne change jamais : le navigateur peut le garder longtemps.
  headers.set('cache-control', 'private, max-age=604800, immutable');
  headers.set('etag', object.httpEtag);
  headers.set('content-disposition', 'inline');
  headers.set('x-content-type-options', 'nosniff');

  if (request.headers.get('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
}

/**
 * Retrait d'un souvenir déjà arrivé.
 *
 * Règle voulue par les mariés : un souvenir envoyé n'est ni modifiable ni
 * effaçable — sauf par celui qui l'a envoyé. On vérifie donc que la session
 * appartient bien à l'auteur, et rien d'autre ne peut réécrire le fichier :
 * plus aucune URL d'écriture n'est signée pour une clé déjà servie.
 */
export async function deleteOwnMedia(request, env, mediaId) {
  const { cid } = await requireGuest(request, env);

  const row = await env.DB.prepare('SELECT * FROM media WHERE id = ?1').bind(mediaId).first();
  if (!row) throw bad('media_unknown', 'Souvenir introuvable.', 404);
  if (row.contributor_id !== cid) {
    throw bad(
      'not_yours',
      'Ce souvenir appartient à quelqu’un d’autre : seul son auteur peut le retirer.',
      403
    );
  }

  await deleteObject(env, row.storage_key, row.remote_id).catch(() => {});
  if (row.thumb_key) await deleteObject(env, row.thumb_key, row.remote_thumb).catch(() => {});

  const batch = [env.DB.prepare('DELETE FROM media WHERE id = ?1').bind(mediaId)];
  if (row.status === 'stored') {
    batch.push(
      env.DB.prepare(
        `UPDATE contributors
            SET media_count = MAX(media_count - 1, 0),
                bytes_total = MAX(bytes_total - ?2, 0)
          WHERE id = ?1`
      ).bind(cid, row.stored_size || 0)
    );
  }
  await env.DB.batch(batch);
  return json({ ok: true });
}

/* ─── Outils ───────────────────────────────────────────────────── */

async function ownedMedia(env, contributorId, mediaId) {
  const row = await env.DB.prepare('SELECT * FROM media WHERE id = ?1 AND contributor_id = ?2')
    .bind(mediaId, contributorId).first();
  if (!row) throw bad('media_unknown', 'Souvenir introuvable.', 404);
  return row;
}

const posInt = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
const posNum = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw bad('bad_request', 'Requête illisible.');
  }
}

async function hashIp(request) {
  const data = new TextEncoder().encode(clientIp(request));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
