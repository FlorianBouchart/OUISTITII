/**
 * storage.js — une seule façade au-dessus de deux chemins d'écriture.
 *
 *   « direct »  (production) : le Worker signe des URL, le téléphone dépose ses
 *                fichiers DIRECTEMENT dans R2. Aucun octet de média ne passe par
 *                le Worker — c'est ce qui permet d'encaisser des vidéos lourdes
 *                sans coût ni limite de traitement.
 *
 *   « relais »  (développement, ou secours si les clés S3 manquent) : le fichier
 *                traverse le Worker qui l'écrit via le binding R2. Même découpage
 *                en parties, même reprise ; le client ne voit pas la différence.
 *
 * Le binding R2 (env.MEDIA) reste utilisé dans les deux modes pour les opérations
 * de contrôle : vérification de taille, lecture, suppression.
 */

import {
  s3Config,
  presign,
  presignPart,
  createMultipartUpload,
  completeMultipartUpload,
  abortMultipartUpload,
} from './s3.js';

export const MIN_PART = 5 * 1024 * 1024; // plancher imposé par le protocole S3

export function storageMode(env) {
  return s3Config(env) ? 'direct' : 'relay';
}

export function partSizeOf(env) {
  const mb = Number(env.PART_SIZE_MB || 8);
  return Math.max(MIN_PART, Math.round(mb) * 1024 * 1024);
}

export function multipartThreshold(env) {
  const mb = Number(env.MULTIPART_THRESHOLD_MB || 8);
  return Math.max(MIN_PART, Math.round(mb) * 1024 * 1024);
}

/* ─── Ouverture d'un envoi ─────────────────────────────────────── */

/**
 * @returns {Promise<{transport:'direct'|'relay', multipart:boolean,
 *                    uploadId?:string, partSize?:number, partsTotal?:number,
 *                    url?:string, urls?:Record<number,string>}>}
 */
export async function beginUpload(env, { key, contentType, size }) {
  const cfg = s3Config(env);
  const partSize = partSizeOf(env);
  const multipart = size > multipartThreshold(env);

  if (!multipart) {
    if (cfg) {
      return {
        transport: 'direct',
        multipart: false,
        url: await presign(cfg, { method: 'PUT', key, contentType, expiresIn: 3600 }),
      };
    }
    return { transport: 'relay', multipart: false };
  }

  const partsTotal = Math.ceil(size / partSize);

  if (cfg) {
    const uploadId = await createMultipartUpload(cfg, key, contentType);
    return {
      transport: 'direct',
      multipart: true,
      uploadId,
      partSize,
      partsTotal,
      urls: await signPartUrls(env, key, uploadId, firstParts(partsTotal)),
    };
  }

  const mp = await env.MEDIA.createMultipartUpload(key, {
    httpMetadata: { contentType },
  });
  return { transport: 'relay', multipart: true, uploadId: mp.uploadId, partSize, partsTotal };
}

/** On ne signe pas 10 000 URL d'avance : par tranches, renouvelables. */
const URL_BATCH = 12;
const firstParts = (total) =>
  Array.from({ length: Math.min(total, URL_BATCH) }, (_, i) => i + 1);

export async function signPartUrls(env, key, uploadId, partNumbers) {
  const cfg = s3Config(env);
  if (!cfg) return null; // en relais, le client poste sur l'API
  const urls = {};
  for (const n of partNumbers) {
    urls[n] = await presignPart(cfg, key, uploadId, n, 3600);
  }
  return urls;
}

/* ─── Écriture en mode relais ──────────────────────────────────── */

export async function relayPut(env, { key, contentType, body }) {
  const object = await env.MEDIA.put(key, body, { httpMetadata: { contentType } });
  return { etag: object.httpEtag || object.etag };
}

export async function relayPart(env, { key, uploadId, partNumber, body }) {
  const mp = env.MEDIA.resumeMultipartUpload(key, uploadId);
  const part = await mp.uploadPart(partNumber, body);
  return { etag: part.etag, partNumber: part.partNumber };
}

/* ─── Clôture / abandon ────────────────────────────────────────── */

export async function finishUpload(env, { key, uploadId, parts, transport }) {
  if (!uploadId) return true; // fichier envoyé en une seule pièce
  if (transport === 'direct') {
    const cfg = s3Config(env);
    if (cfg) return completeMultipartUpload(cfg, key, uploadId, parts);
  }
  const mp = env.MEDIA.resumeMultipartUpload(key, uploadId);
  await mp.complete(
    parts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({ partNumber: p.partNumber, etag: normalizeEtag(p.etag) }))
  );
  return true;
}

export async function abortUpload(env, { key, uploadId, transport }) {
  if (!uploadId) return true;
  try {
    if (transport === 'direct') {
      const cfg = s3Config(env);
      if (cfg) return await abortMultipartUpload(cfg, key, uploadId);
    }
    await env.MEDIA.resumeMultipartUpload(key, uploadId).abort();
    return true;
  } catch {
    return false; // R2 nettoie de lui-même les envois fractionnés abandonnés
  }
}

const normalizeEtag = (etag) => String(etag || '').replace(/^"|"$/g, '');

/* ─── Contrôle a posteriori ────────────────────────────────────── */

/** Taille réellement écrite : c'est elle qui fait foi, pas ce que dit le client. */
export async function headObject(env, key) {
  const head = await env.MEDIA.head(key);
  return head ? { size: head.size, etag: head.httpEtag, uploaded: head.uploaded } : null;
}

export const getObject = (env, key) => env.MEDIA.get(key);
export const deleteObject = (env, key) => env.MEDIA.delete(key);
