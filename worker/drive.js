/**
 * drive.js — stockage sur le Google Drive des mariés.
 *
 * Pourquoi Drive plutôt qu'un stockage objet : les quinze gigaoctets offerts
 * avec un compte Google suffisent au mariage, ils n'exigent aucune carte
 * bancaire, et les souvenirs atterrissent dans un espace que les mariés
 * possèdent déjà et savent utiliser.
 *
 * Comment les fichiers y arrivent sans passer par le Worker
 * ────────────────────────────────────────────────────────
 * Drive sait ouvrir une « session d'envoi reprenable » : le Worker la crée avec
 * ses identifiants, Google répond par une adresse temporaire, et c'est le
 * téléphone qui y dépose les octets — directement, sans jamais voir le moindre
 * jeton. Exactement le principe des URL signées, avec la reprise en prime :
 * une session interrompue redémarre à l'octet près.
 *
 * Les identifiants ne quittent jamais le Worker. Le navigateur ne reçoit qu'une
 * adresse de session, valable pour un seul fichier et une seule fois.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about';

/** Configuration présente ? Sinon l'application reste en mode local. */
export function driveConfig(env) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  return {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    refreshToken: GOOGLE_REFRESH_TOKEN,
    folderId: env.GOOGLE_FOLDER_ID || null,
  };
}

/* ─── Jeton d'accès ────────────────────────────────────────────── */

// Un jeton vaut une heure : on le garde le temps de sa validité plutôt que
// d'en redemander un à chaque fichier.
let cached = { token: null, expires: 0 };

export async function accessToken(cfg) {
  const now = Date.now();
  if (cached.token && cached.expires > now + 60_000) return cached.token;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    throw new Error(`Google refuse le jeton (${response.status}) : ${(await response.text()).slice(0, 200)}`);
  }
  const data = await response.json();
  cached = {
    token: data.access_token,
    expires: now + (data.expires_in || 3600) * 1000,
  };
  return cached.token;
}

/* ─── Dossiers ─────────────────────────────────────────────────── */

/**
 * Range les souvenirs comme on rangerait un album : un dossier par type, puis
 * un dossier par invité. Les dossiers déjà créés sont réutilisés.
 */
const folderCache = new Map();

export async function ensureFolder(cfg, token, name, parentId) {
  const key = `${parentId || 'root'}/${name}`;
  if (folderCache.has(key)) return folderCache.get(key);

  const query = [
    `name='${name.replace(/'/g, "\\'")}'`,
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    parentId ? `'${parentId}' in parents` : null,
  ].filter(Boolean).join(' and ');

  const found = await fetch(
    `${FILES_URL}?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`,
    { headers: { authorization: `Bearer ${token}` } }
  ).then((r) => r.json());

  if (found.files?.length) {
    folderCache.set(key, found.files[0].id);
    return found.files[0].id;
  }

  const created = await fetch(`${FILES_URL}?fields=id`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    }),
  }).then((r) => r.json());

  if (!created.id) throw new Error('Dossier Drive impossible à créer');
  folderCache.set(key, created.id);
  return created.id;
}

/* ─── Envoi ────────────────────────────────────────────────────── */

/**
 * Ouvre une session d'envoi et renvoie l'adresse que le téléphone utilisera.
 * C'est le seul élément transmis au navigateur : ni jeton, ni identifiant.
 */
export async function createUploadSession(cfg, { name, mimeType, size, parents }) {
  const token = await accessToken(cfg);

  const response = await fetch(`${UPLOAD_URL}?uploadType=resumable&fields=id,size`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify({ name, mimeType, parents }),
  });

  if (!response.ok) {
    throw new Error(`Drive refuse la session (${response.status}) : ${(await response.text()).slice(0, 200)}`);
  }
  const location = response.headers.get('location');
  if (!location) throw new Error('Drive n’a pas renvoyé d’adresse de session');
  return location;
}

/** Où en est une session interrompue ? Renvoie le nombre d'octets déjà reçus. */
export async function sessionProgress(sessionUrl, size) {
  const response = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'content-range': `bytes */${size}` },
  });
  if (response.status === 200 || response.status === 201) return size;
  if (response.status !== 308) return 0;

  const range = response.headers.get('range');
  return range ? Number(range.split('-')[1]) + 1 : 0;
}

/* ─── Lecture, suppression, quota ──────────────────────────────── */

export async function readFile(cfg, fileId) {
  const token = await accessToken(cfg);
  return fetch(`${FILES_URL}/${fileId}?alt=media`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function deleteFile(cfg, fileId) {
  const token = await accessToken(cfg);
  const response = await fetch(`${FILES_URL}/${fileId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return response.ok || response.status === 404;
}

export async function fileSize(cfg, fileId) {
  const token = await accessToken(cfg);
  const data = await fetch(`${FILES_URL}/${fileId}?fields=size`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => (r.ok ? r.json() : null));
  return data?.size ? Number(data.size) : null;
}

/** Place réellement disponible sur le Drive — la vérité, côté Google. */
export async function driveQuota(cfg) {
  const token = await accessToken(cfg);
  const data = await fetch(`${ABOUT_URL}?fields=storageQuota`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => (r.ok ? r.json() : null));

  const q = data?.storageQuota;
  if (!q) return null;
  const limit = Number(q.limit || 0);
  const used = Number(q.usage || 0);
  return { used, limit, free: limit ? Math.max(limit - used, 0) : null };
}

/** Envoi direct depuis le Worker — pour les vignettes, qui sont minuscules. */
export async function uploadSmall(cfg, { name, mimeType, parents, body }) {
  const token = await accessToken(cfg);
  const boundary = `oui${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, mimeType, parents });

  const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;

  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  const payload = new Blob([head, bytes, tail]);

  const response = await fetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,size`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/related; boundary=${boundary}`,
    },
    body: payload,
  });
  if (!response.ok) {
    throw new Error(`Drive refuse le fichier (${response.status}) : ${(await response.text()).slice(0, 160)}`);
  }
  return response.json();
}
