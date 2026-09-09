/**
 * admin.js — l'espace des mariés.
 *
 * Pas de tableau de bord d'entreprise : une page protégée par un mot de passe,
 * qui répond aux seules questions utiles après la fête — qui a envoyé quoi,
 * combien pèse l'ensemble, comment tout récupérer, comment retirer un fichier.
 */

import { json, bad, timingSafeEqual, rateLimit, clientIp, formatBytes } from './util.js';
import { issueAdminToken, requireAdmin } from './auth.js';
import { getObject, deleteObject, abortUpload, storageMode } from './storage.js';

export async function adminLogin(request, env) {
  await rateLimit(env.DB, 'admin', clientIp(request), 10, 900);
  const { password } = await request.json().catch(() => ({}));
  if (!env.ADMIN_PASSWORD) throw bad('server_misconfigured', 'Espace non configuré.', 503);
  if (!timingSafeEqual(password || '', env.ADMIN_PASSWORD)) {
    throw bad('wrong_password', 'Mot de passe incorrect.', 401);
  }
  return json({ token: await issueAdminToken(env) });
}

export async function overview(request, env) {
  await requireAdmin(request, env);

  const totals = await env.DB.prepare(
    `SELECT
       COUNT(*)                                             AS total,
       SUM(CASE WHEN kind='photo' THEN 1 ELSE 0 END)        AS photos,
       SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END)        AS videos,
       COALESCE(SUM(stored_size), 0)                        AS bytes
     FROM media WHERE status='stored'`
  ).first();

  const pending = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM media WHERE status <> 'stored' GROUP BY status`
  ).all();

  const contributors = await env.DB.prepare(
    `SELECT c.display_name, c.slug, c.last_seen_at,
            COUNT(m.id)                                        AS total,
            SUM(CASE WHEN m.kind='photo' THEN 1 ELSE 0 END)    AS photos,
            SUM(CASE WHEN m.kind='video' THEN 1 ELSE 0 END)    AS videos,
            COALESCE(SUM(m.stored_size), 0)                    AS bytes
       FROM contributors c
       LEFT JOIN media m ON m.contributor_id = c.id AND m.status='stored'
      GROUP BY c.id
      ORDER BY total DESC, c.display_name ASC`
  ).all();

  return json({
    totals: {
      total: totals?.total || 0,
      photos: totals?.photos || 0,
      videos: totals?.videos || 0,
      bytes: totals?.bytes || 0,
      bytesLabel: formatBytes(totals?.bytes || 0),
    },
    pending: pending.results,
    contributors: contributors.results,
    transport: storageMode(env),
    bucket: env.S3_BUCKET || 'ouistitii-medias',
  });
}

export async function listMedia(request, env, url) {
  await requireAdmin(request, env);

  const limit = Math.min(Number(url.searchParams.get('limit') || 60), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
  const kind = url.searchParams.get('kind');
  const slug = url.searchParams.get('contributor');
  const status = url.searchParams.get('status') || 'stored';

  const where = ['m.status = ?1'];
  const binds = [status];
  if (kind === 'photo' || kind === 'video') { binds.push(kind); where.push(`m.kind = ?${binds.length}`); }
  if (slug) { binds.push(slug); where.push(`c.slug = ?${binds.length}`); }

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.kind, m.mime, m.original_name, m.storage_key, m.stored_size, m.size,
            m.created_at, m.completed_at, m.taken_at, m.source, m.status, m.error,
            m.thumb_key IS NOT NULL AS has_thumb,
            c.display_name, c.slug
       FROM media m JOIN contributors c ON c.id = m.contributor_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`
  ).bind(...binds).all();

  return json({ items: results, limit, offset });
}

/** Téléchargement d'un média : le bucket reste privé, tout passe par ici. */
export async function downloadMedia(request, env, mediaId) {
  await requireAdmin(request, env);
  const row = await env.DB.prepare(
    'SELECT storage_key, remote_id, mime, original_name, ext FROM media WHERE id = ?1'
  ).bind(mediaId).first();
  if (!row) throw bad('media_unknown', 'Média introuvable.', 404);

  const object = await getObject(env, row.storage_key, row.remote_id);
  if (!object) throw bad('media_missing', 'Fichier absent du stockage.', 404);

  const filename = row.storage_key.split('/').pop();
  return new Response(object.body, {
    headers: {
      'content-type': row.mime || 'application/octet-stream',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, max-age=0, no-store',
    },
  });
}

export async function deleteMedia(request, env, mediaId) {
  await requireAdmin(request, env);
  const row = await env.DB.prepare('SELECT * FROM media WHERE id = ?1').bind(mediaId).first();
  if (!row) throw bad('media_unknown', 'Média introuvable.', 404);

  if (row.upload_id) {
    await abortUpload(env, {
      key: row.storage_key,
      uploadId: row.upload_id,
      transport: storageMode(env),
    });
  }
  await deleteObject(env, row.storage_key, row.remote_id);
  if (row.thumb_key) await deleteObject(env, row.thumb_key, row.remote_thumb).catch(() => {});

  const batch = [env.DB.prepare('DELETE FROM media WHERE id = ?1').bind(mediaId)];
  if (row.status === 'stored') {
    batch.push(
      env.DB.prepare(
        `UPDATE contributors
            SET media_count = MAX(media_count - 1, 0),
                bytes_total = MAX(bytes_total - ?2, 0)
          WHERE id = ?1`
      ).bind(row.contributor_id, row.stored_size || 0)
    );
  }
  await env.DB.batch(batch);

  return json({ ok: true });
}

/** Manifeste complet — de quoi retrouver l'auteur de chaque fichier, hors ligne. */
export async function exportCsv(request, env) {
  await requireAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT c.display_name, c.slug, m.kind, m.original_name, m.storage_key,
            m.stored_size, m.mime, m.source, m.taken_at, m.completed_at, m.status
       FROM media m JOIN contributors c ON c.id = m.contributor_id
      WHERE m.status = 'stored'
      ORDER BY c.display_name, m.completed_at`
  ).all();

  const head = [
    'Contributeur', 'Identifiant', 'Type', 'Nom d’origine', 'Chemin de stockage',
    'Taille (octets)', 'Format', 'Provenance', 'Prise de vue', 'Reçu le',
  ];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = results.map((r) =>
    [
      r.display_name, r.slug, r.kind === 'photo' ? 'Photo' : 'Vidéo', r.original_name,
      r.storage_key, r.stored_size, r.mime,
      r.source === 'camera' ? 'Appareil photo' : 'Galerie',
      r.taken_at || '', r.completed_at || '',
    ].map(escape).join(';')
  );

  // BOM : Excel ouvre alors les accents correctement.
  return new Response('﻿' + [head.map(escape).join(';'), ...rows].join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="ouistitii-souvenirs.csv"',
      'cache-control': 'no-store',
    },
  });
}

/** Ménage : envois restés en plan depuis plus de 24 h. */
export async function cleanupStale(request, env) {
  await requireAdmin(request, env);
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, storage_key, thumb_key, remote_id, remote_thumb, upload_id FROM media
      WHERE status IN ('pending','uploading','failed') AND created_at < ?1 LIMIT 200`
  ).bind(cutoff).all();

  for (const row of results) {
    if (row.upload_id) {
      await abortUpload(env, {
        key: row.storage_key,
        uploadId: row.upload_id,
        transport: storageMode(env),
      });
    }
    await deleteObject(env, row.storage_key, row.remote_id).catch(() => {});
    if (row.thumb_key) await deleteObject(env, row.thumb_key, row.remote_thumb).catch(() => {});
    await env.DB.prepare('DELETE FROM media WHERE id = ?1').bind(row.id).run();
  }
  return json({ ok: true, cleaned: results.length });
}
