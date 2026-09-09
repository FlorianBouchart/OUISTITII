/**
 * auth.js — jetons signés.
 *
 * Aucun compte, aucun mot de passe pour les invités : donner son prénom et son
 * nom ouvre une session signée (HMAC-SHA256) valable douze heures. Le jeton
 * porte l'identifiant du contributeur, ce qui empêche d'envoyer des médias au
 * nom de quelqu'un d'autre sans passer par l'écran d'identification.
 */

import { bad } from './util.js';

const ENCODER = new TextEncoder();
const GUEST_TTL = 12 * 3600;      // 12 h — couvre largement une journée de fête
const ADMIN_TTL = 8 * 3600;

/* ─── base64url ────────────────────────────────────────────────── */

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ENCODER.encode(message)));
}

/* ─── Émission / vérification ──────────────────────────────────── */

function secretOf(env) {
  const secret = env.TOKEN_SECRET;
  if (!secret) throw bad('server_misconfigured', 'Service momentanément indisponible.', 503);
  return secret;
}

export async function issueToken(env, claims, ttlSeconds) {
  const payload = { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64urlEncode(ENCODER.encode(JSON.stringify(payload)));
  const signature = b64urlEncode(await sign(secretOf(env), body));
  return `${body}.${signature}`;
}

export async function verifyToken(env, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  let expected;
  try {
    expected = b64urlEncode(await sign(secretOf(env), body));
  } catch {
    return null;
  }
  if (expected.length !== signature.length) return null;

  // comparaison à temps constant
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff !== 0) return null;

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

/* ─── Helpers de requête ───────────────────────────────────────── */

export const issueGuestToken = (env, contributorId, sessionId) =>
  issueToken(env, { cid: contributorId, sid: sessionId, role: 'guest' }, GUEST_TTL);

export const issueAdminToken = (env) => issueToken(env, { role: 'admin' }, ADMIN_TTL);

function bearerOf(request) {
  const header = request.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** Session invité obligatoire. Lève une erreur explicite si elle a expiré. */
export async function requireGuest(request, env) {
  const claims = await verifyToken(env, bearerOf(request));
  if (!claims || claims.role !== 'guest') {
    throw bad(
      'session_expired',
      'Votre session a expiré. Indiquez à nouveau votre nom, vos souvenirs sont conservés.',
      401
    );
  }
  return claims;
}

export async function requireAdmin(request, env) {
  const claims = await verifyToken(env, bearerOf(request));
  if (!claims || claims.role !== 'admin') {
    throw bad('admin_required', 'Accès réservé aux mariés.', 401);
  }
  return claims;
}

export { GUEST_TTL, ADMIN_TTL };
