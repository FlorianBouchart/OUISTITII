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
  driveConfig, createUploadSession, ensureFolder, accessToken,
  readFile, deleteFile, fileSize, uploadSmall,
} from './drive.js';
import {
  s3Config,
  presign,
  presignPart,
  createMultipartUpload,
  completeMultipartUpload,
  abortMultipartUpload,
} from './s3.js';

export const MIN_PART = 5 * 1024 * 1024; // plancher imposé par le protocole S3

/**
 * Trois façons d'écrire, choisies d'après ce qui est configuré :
 *   'drive'  — le Google Drive des mariés (quinze gigaoctets offerts, aucune
 *              carte bancaire) ; les fichiers y montent par tranches, à travers
 *              le Worker, ce qui évite tout blocage entre origines et reste très
 *              au-dessous des quotas gratuits ;
 *   'direct' — un stockage objet compatible S3, par URL signée ;
 *   'relay'  — le stockage local de développement.
 */
export function storageMode(env) {
  if (driveConfig(env)) return 'drive';
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
export async function beginUpload(env, { key, contentType, size, kind, contributor }) {
  const drive = driveConfig(env);
  if (drive) return beginDriveUpload(env, drive, { key, contentType, size, kind, contributor });

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

/**
 * Ouvre la session d'envoi chez Google et range le fichier dans l'arborescence
 * de l'album : un dossier par type, puis un dossier par invité.
 */
async function beginDriveUpload(env, cfg, { key, contentType, size, kind, contributor }) {
  const token = await accessToken(cfg);
  const root = await ensureFolder(cfg, token, env.EVENT_PREFIX || 'OUISTITII', cfg.folderId);
  const byKind = await ensureFolder(cfg, token, kind === 'video' ? 'Videos' : 'Photos', root);
  const byGuest = await ensureFolder(cfg, token, contributor?.displayName || 'Invites', byKind);

  const sessionUrl = await createUploadSession(cfg, {
    name: key.split('/').pop(),
    mimeType: contentType,
    size,
    parents: [byGuest],
  });

  const partSize = partSizeOf(env);
  return {
    transport: 'drive',
    multipart: size > partSize,
    sessionUrl,
    partSize,
    partsTotal: Math.max(Math.ceil(size / partSize), 1),
  };
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

/**
 * Transmet une tranche à Google, à sa place exacte dans le fichier. Google
 * répond 308 tant qu'il en attend d'autres, 200 quand tout est arrivé — et
 * c'est à ce moment qu'il donne l'identifiant du fichier.
 */
export async function driveChunk(env, { sessionUrl, body, start, end, total }) {
  const response = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'content-range': `bytes ${start}-${end}/${total}` },
    body,
  });

  if (response.status === 308) return { done: false };
  if (response.status === 200 || response.status === 201) {
    const data = await response.json().catch(() => ({}));
    return { done: true, id: data.id, size: Number(data.size || 0) };
  }
  throw new Error(`Drive refuse la tranche (${response.status}) : ${(await response.text()).slice(0, 160)}`);
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
export async function headObject(env, key, remoteId) {
  const drive = driveConfig(env);
  if (drive) {
    if (!remoteId) return null;
    const size = await fileSize(drive, remoteId);
    return size === null ? null : { size };
  }
  const head = await env.MEDIA.head(key);
  return head ? { size: head.size, etag: head.httpEtag, uploaded: head.uploaded } : null;
}

/** Lecture d'un média, quel que soit l'endroit où il dort. */
export async function getObject(env, key, remoteId) {
  const drive = driveConfig(env);
  if (drive) {
    if (!remoteId) return null;
    const response = await readFile(drive, remoteId);
    if (!response.ok) return null;
    return {
      body: response.body,
      size: Number(response.headers.get('content-length') || 0),
      httpEtag: response.headers.get('etag') || '',
    };
  }
  return env.MEDIA.get(key);
}

export async function deleteObject(env, key, remoteId) {
  const drive = driveConfig(env);
  if (drive) return remoteId ? deleteFile(drive, remoteId) : true;
  return env.MEDIA.delete(key);
}

/** Dépôt d'une vignette : elle est minuscule, elle passe par le Worker. */
export async function putThumbObject(env, { key, body, contentType, kind, contributor }) {
  const drive = driveConfig(env);
  if (!drive) {
    const object = await env.MEDIA.put(key, body, { httpMetadata: { contentType } });
    return { ok: Boolean(object) };
  }
  const token = await accessToken(drive);
  const root = await ensureFolder(drive, token, env.EVENT_PREFIX || 'OUISTITII', drive.folderId);
  const previews = await ensureFolder(drive, token, 'Apercus', root);
  const file = await uploadSmall(drive, {
    name: key.split('/').pop(),
    mimeType: 'image/jpeg',
    parents: [previews],
    body,
  });
  return { ok: Boolean(file?.id), id: file?.id };
}
