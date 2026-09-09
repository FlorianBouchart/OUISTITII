/**
 * api.js — dialogue avec le Worker. Une seule origine, un jeton en mémoire
 * (doublé dans sessionStorage pour survivre à un rechargement de page).
 */

const TOKEN_KEY = 'ouistitii.token';
const GUEST_KEY = 'ouistitii.guest';

let token = null;

/* ─── Session ──────────────────────────────────────────────────── */

export function loadSession() {
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(GUEST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(data) {
  token = data.token;
  try {
    sessionStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(
      GUEST_KEY,
      JSON.stringify({
        firstName: data.firstName,
        lastName: data.lastName,
        displayName: data.contributor.displayName,
        slug: data.contributor.slug,
        sessionId: data.sessionId,
        config: data.config,
      })
    );
  } catch { /* navigation privée : la session vivra le temps de l'onglet */ }
}

export function clearSession() {
  token = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(GUEST_KEY);
  } catch { /* rien à nettoyer */ }
}

export const hasToken = () => Boolean(token);

/* ─── Erreurs ──────────────────────────────────────────────────── */

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* ─── Requêtes ─────────────────────────────────────────────────── */

async function request(path, { method = 'POST', body, signal, raw } = {}) {
  // GET et DELETE n'ont pas de corps : on ne pose pas de content-type inutile.
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('network', 'Connexion perdue. L’envoi reprendra tout seul.', 0);
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      payload.error || 'server_error',
      payload.message || 'Une erreur est survenue.',
      response.status
    );
  }
  return payload;
}

/* ─── Points d'entrée ──────────────────────────────────────────── */

export async function openSession(firstName, lastName) {
  const data = await request('/api/session', { body: { firstName, lastName } });
  saveSession({ ...data, firstName, lastName });
  return data;
}

export const checkFingerprints = (fingerprints) =>
  request('/api/media/check', { body: { fingerprints } });

export const initUpload = (payload) => request('/api/media/init', { body: payload });

export const morePartUrls = (mediaId, partNumbers) =>
  request(`/api/media/${mediaId}/parts`, { body: { partNumbers } });

export const completeUpload = (mediaId, parts) =>
  request(`/api/media/${mediaId}/complete`, { body: { parts } });

export const failUpload = (mediaId, error, abandon = false) =>
  request(`/api/media/${mediaId}/fail`, { body: { error, abandon } }).catch(() => null);

export const relayUrl = (mediaId, partNumber) =>
  `/api/relay/${mediaId}${partNumber ? `/${partNumber}` : ''}`;

/**
 * La vignette que le téléphone a déjà fabriquée pour sa propre file : on la
 * dépose telle quelle, c'est elle qui fera vivre l'album partagé.
 * Best effort — un souvenir sans vignette reste un souvenir bien arrivé.
 */
export async function putThumb(mediaId, blob) {
  try {
    await fetch(`/api/media/${mediaId}/thumb`, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', ...authHeader() },
      body: blob,
    });
  } catch { /* sans conséquence sur l'envoi */ }
}

export const gallery = (params) =>
  request(`/api/gallery?${new URLSearchParams(params)}`, { method: 'GET' });

export const removeMedia = (mediaId) =>
  request(`/api/media/${mediaId}`, { method: 'DELETE' });

export const authHeader = () => (token ? { authorization: `Bearer ${token}` } : {});
