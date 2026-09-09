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
import { issueGuestToken, requireGuest } from './auth.js';
import {
  storageMode, beginUpload, signPartUrls, finishUpload, abortUpload,
  relayPut, relayPart, headObject, deleteObject, partSizeOf, multipartThreshold,
} from './storage.js';

const maxFileBytes = (env) => Number(env.MAX_FILE_MB || 600) * 1024 * 1024;

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

  return json({
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
    },
  });
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

  const upload = await beginUpload(env, { key, contentType: mime, size });

  await env.DB.prepare(
    `INSERT INTO media
       (id, contributor_id, session_id, kind, mime, ext, size, original_name, storage_key,
        fingerprint, source, taken_at, status, upload_id, part_size, parts_total, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending',?13,?14,?15,?16)`
  ).bind(
    mediaId, cid, sid, kind, mime, ext, size,
    String(body.name || '').slice(0, 160), key, fingerprint,
    body.source === 'camera' ? 'camera' : 'gallery',
    body.takenAt ? String(body.takenAt).slice(0, 40) : null,
    upload.uploadId || null, upload.partSize || null, upload.partsTotal || null, nowISO()
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

  if (row.upload_id) {
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
  const head = await headObject(env, row.storage_key);
  if (!head) {
    await markFailed(env, mediaId, 'objet absent après clôture');
    throw bad('upload_incomplete', 'L’envoi n’est pas allé au bout. Réessayez.', 409);
  }
  if (head.size > maxFileBytes(env) || (row.size && Math.abs(head.size - row.size) > 1024)) {
    await deleteObject(env, row.storage_key);
    await env.DB.prepare(
      `UPDATE media SET status='rejected', error='taille inattendue', stored_size=?2 WHERE id=?1`
    ).bind(mediaId, head.size).run();
    throw bad('size_mismatch', 'Ce fichier a été modifié pendant l’envoi. Réessayez.', 409);
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE media SET status='stored', stored_size=?2, completed_at=?3, upload_id=NULL, error=NULL
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

/* ─── Outils ───────────────────────────────────────────────────── */

async function ownedMedia(env, contributorId, mediaId) {
  const row = await env.DB.prepare('SELECT * FROM media WHERE id = ?1 AND contributor_id = ?2')
    .bind(mediaId, contributorId).first();
  if (!row) throw bad('media_unknown', 'Souvenir introuvable.', 404);
  return row;
}

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
