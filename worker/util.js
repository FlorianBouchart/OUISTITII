/**
 * util.js — briques communes : réponses JSON, normalisation, validation,
 * empreintes de fichiers et garde-fous anti-abus.
 */

/* ─── Réponses ─────────────────────────────────────────────────── */

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

/** Erreur métier : message lisible par un invité, jamais de détail technique. */
export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const bad = (code, message, status = 400) => new AppError(code, message, status);

/* ─── Normalisation ────────────────────────────────────────────── */

/** "Élodie De Saint-Cyr" → "elodie-de-saint-cyr" */
export function slugify(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Met une majuscule à chaque partie d'un nom, tirets et apostrophes compris. */
export function titleCase(str) {
  return String(str)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s\-'’])([\p{L}])/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Nom de fichier sûr : pas de séparateur, pas de caractère de contrôle. */
export function safeName(name, fallback = 'souvenir') {
  const base = String(name || '')
    .split(/[\\/]/).pop()
    .replace(/\.[^.]+$/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  return base || fallback;
}

export function uuid() {
  return crypto.randomUUID();
}

export const nowISO = () => new Date().toISOString();

/* ─── Types de fichiers acceptés ───────────────────────────────── */

export const MIME_MAP = {
  'image/jpeg':      { kind: 'photo', ext: 'jpg' },
  'image/pjpeg':     { kind: 'photo', ext: 'jpg' },
  'image/png':       { kind: 'photo', ext: 'png' },
  'image/heic':      { kind: 'photo', ext: 'heic' },
  'image/heif':      { kind: 'photo', ext: 'heic' },
  'image/webp':      { kind: 'photo', ext: 'webp' },
  'image/gif':       { kind: 'photo', ext: 'gif' },
  'image/avif':      { kind: 'photo', ext: 'avif' },
  'video/mp4':       { kind: 'video', ext: 'mp4' },
  'video/quicktime': { kind: 'video', ext: 'mov' },
  'video/webm':      { kind: 'video', ext: 'webm' },
  'video/3gpp':      { kind: 'video', ext: '3gp' },
  'video/x-matroska':{ kind: 'video', ext: 'mkv' },
  'video/mpeg':      { kind: 'video', ext: 'mpg' },
};

export function describeMime(mime) {
  const entry = MIME_MAP[String(mime || '').toLowerCase()];
  if (!entry) throw bad('unsupported_type', "Ce format de fichier n'est pas accepté.", 415);
  return entry;
}

/**
 * Vérifie que les premiers octets du fichier correspondent bien au type annoncé.
 * Le fichier partant directement du téléphone vers le stockage, c'est ici qu'on
 * empêche qu'un exécutable soit déposé sous une étiquette « image/jpeg ».
 * `head` : les 64 premiers octets, en base64.
 */
export function magicMatches(mime, headB64) {
  if (!headB64) return false;
  let bytes;
  try {
    const bin = atob(headB64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return false;
  }
  if (bytes.length < 12) return false;

  const ascii = (from, len) =>
    String.fromCharCode(...bytes.slice(from, from + len));
  const starts = (...sig) => sig.every((b, i) => bytes[i] === b);

  const isJpeg = starts(0xff, 0xd8, 0xff);
  const isPng  = starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const isGif  = ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
  const isRiff = ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  const isIsoBmff = ascii(4, 4) === 'ftyp';      // MP4, MOV, HEIC, AVIF, 3GP
  const isMatroska = starts(0x1a, 0x45, 0xdf, 0xa3); // MKV / WebM
  const isMpeg = starts(0x00, 0x00, 0x01, 0xba) || starts(0x00, 0x00, 0x01, 0xb3);

  switch (String(mime).toLowerCase()) {
    case 'image/jpeg':
    case 'image/pjpeg':      return isJpeg;
    case 'image/png':        return isPng;
    case 'image/gif':        return isGif;
    case 'image/webp':       return isRiff;
    case 'image/heic':
    case 'image/heif':
    case 'image/avif':       return isIsoBmff;
    case 'video/mp4':
    case 'video/quicktime':
    case 'video/3gpp':       return isIsoBmff;
    case 'video/webm':
    case 'video/x-matroska': return isMatroska;
    case 'video/mpeg':       return isMpeg || isIsoBmff;
    default:                 return false;
  }
}

/* ─── Garde-fou anti-abus ──────────────────────────────────────── */

/**
 * Compteur à fenêtre glissante stocké dans D1. Volontairement simple :
 * il s'agit d'endiguer un envoi automatisé, pas de protéger un service public.
 */
export async function rateLimit(db, scope, identifier, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSeconds) * windowSeconds;
  const key = `${scope}:${identifier}:${window}`;

  await db
    .prepare(
      `INSERT INTO rate_limit (bucket_key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1`
    )
    .bind(key, window)
    .run();

  const row = await db
    .prepare('SELECT count FROM rate_limit WHERE bucket_key = ?1')
    .bind(key)
    .first();

  if (row && row.count > limit) {
    throw bad(
      'rate_limited',
      'Trop de demandes coup sur coup. Patientez quelques instants puis réessayez.',
      429
    );
  }
}

/** Nettoyage opportuniste des compteurs expirés (appelé en tâche de fond). */
export async function purgeRateLimits(db) {
  const cutoff = Math.floor(Date.now() / 1000) - 7200;
  await db.prepare('DELETE FROM rate_limit WHERE window_start < ?1').bind(cutoff).run();
}

/* ─── Divers ───────────────────────────────────────────────────── */

export function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    '0.0.0.0'
  );
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparaison à temps constant, pour le mot de passe des mariés. */
export function timingSafeEqual(a, b) {
  const ba = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

export function formatBytes(n) {
  if (!n) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
