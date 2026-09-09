/**
 * OUISTITII par T&F — Worker unique : il sert l'application ET son API.
 * Un seul domaine, donc aucun échange inter-origines côté invité, et un seul
 * `wrangler deploy` pour mettre le tout à jour.
 */

import { json, AppError, purgeRateLimits } from './util.js';
import { ensureSchema, invalidateSchema } from './schema.js';
import {
  openSession, checkFingerprints, initUpload, morePartUrls,
  completeUpload, failUpload, relayUpload,
  putThumb, listGallery, serveMedia, deleteOwnMedia,
} from './media.js';
import {
  adminLogin, overview, listMedia, downloadMedia, deleteMedia, exportCsv, cleanupStale,
} from './admin.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return withSecurityHeaders(await env.ASSETS.fetch(request), env, url.pathname);
    }

    if (request.method === 'OPTIONS') return preflight(request);

    try {
      // La base se crée d'elle-même au premier appel : l'application ne doit
      // pas dépendre d'une commande lancée à la main avant de fonctionner.
      await ensureSchema(env);
      const response = await route(request, env, url, ctx);
      return withCors(response, request);
    } catch (error) {
      if (error instanceof AppError) {
        return withCors(json({ error: error.code, message: error.message }, error.status), request);
      }
      console.error('[ouistitii]', error?.stack || error);
      // Une panne de base peut venir d'un schéma devenu faux : la prochaine
      // requête le revérifiera plutôt que de se fier à un état périmé.
      if (/D1|database|no such table|no column/i.test(String(error?.message || ''))) {
        invalidateSchema();
      }
      return withCors(
        json(
          {
            error: 'server_error',
            message: 'Le service a rencontré un incident. Vos souvenirs sont conservés sur votre téléphone, réessayez dans un instant.',
          },
          500
        ),
        request
      );
    }
  },
};

/* ─── Routage ──────────────────────────────────────────────────── */

async function route(request, env, url, ctx) {
  const path = url.pathname;
  const method = request.method;
  const segments = path.split('/').filter(Boolean); // ['api', ...]

  // Ménage opportuniste, hors du chemin critique.
  if (Math.random() < 0.02) ctx.waitUntil(purgeRateLimits(env.DB).catch(() => {}));

  /* Invités */
  if (path === '/api/session' && method === 'POST') return openSession(request, env);
  if (path === '/api/media/check' && method === 'POST') return checkFingerprints(request, env);
  if (path === '/api/media/init' && method === 'POST') return initUpload(request, env);

  if (segments[0] === 'api' && segments[1] === 'media' && segments.length === 4) {
    const [, , mediaId, action] = segments;
    if (method === 'POST') {
      if (action === 'parts') return morePartUrls(request, env, mediaId);
      if (action === 'complete') return completeUpload(request, env, mediaId);
      if (action === 'fail') return failUpload(request, env, mediaId);
    }
    if (method === 'PUT' && action === 'thumb') return putThumb(request, env, mediaId);
    // Galerie : aperçu et original, servis depuis le seau privé.
    if (method === 'GET' && (action === 'thumb' || action === 'file')) {
      return serveMedia(request, env, mediaId, action);
    }
  }

  // Un souvenir arrivé ne se retire que par la main qui l'a envoyé.
  if (segments[0] === 'api' && segments[1] === 'media' && segments.length === 3 && method === 'DELETE') {
    return deleteOwnMedia(request, env, segments[2]);
  }

  if (path === '/api/gallery' && method === 'GET') return listGallery(request, env, url);

  // Relais : PUT /api/relay/<mediaId>[/<numéro de partie>]
  if (segments[0] === 'api' && segments[1] === 'relay' && method === 'PUT') {
    return relayUpload(request, env, segments[2], segments[3]);
  }

  /* Mariés */
  if (path === '/api/admin/login' && method === 'POST') return adminLogin(request, env);
  if (path === '/api/admin/overview' && method === 'GET') return overview(request, env);
  if (path === '/api/admin/media' && method === 'GET') return listMedia(request, env, url);
  if (path === '/api/admin/export.csv' && method === 'GET') return exportCsv(request, env);
  if (path === '/api/admin/cleanup' && method === 'POST') return cleanupStale(request, env);

  if (segments[0] === 'api' && segments[1] === 'admin' && segments[2] === 'media' && segments[3]) {
    if (segments[4] === 'file' && method === 'GET') return downloadMedia(request, env, segments[3]);
    if (segments.length === 4 && method === 'DELETE') return deleteMedia(request, env, segments[3]);
  }

  if (path === '/api/health') {
    return json({ ok: true, service: 'ouistitii', date: env.EVENT_DATE });
  }

  return json({ error: 'not_found', message: 'Ressource inconnue.' }, 404);
}

/* ─── En-têtes ─────────────────────────────────────────────────── */

function contentSecurityPolicy(env) {
  const r2 = env.S3_ENDPOINT ? new URL(env.S3_ENDPOINT).origin : 'https://*.r2.cloudflarestorage.com';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self' ${r2}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Politique de cache. Sans elle, une mise à jour n'atteint jamais les
 * téléphones qui ont déjà ouvert l'application : la page reste celle du
 * premier jour.
 *
 *   les pages  → revalidées à chaque visite, pour que les correctifs arrivent
 *   le reste   → gardées un an ; leur adresse porte un numéro de version, un
 *                fichier modifié change donc d'adresse
 */
function cachePolicy(pathname) {
  if (pathname === '/' || pathname.endsWith('.html') || pathname.endsWith('.webmanifest')) {
    return 'no-cache, must-revalidate';
  }
  return 'public, max-age=31536000, immutable';
}

function withSecurityHeaders(response, env, pathname = '/') {
  const headers = new Headers(response.headers);
  headers.set('cache-control', cachePolicy(pathname));
  headers.set('content-security-policy', contentSecurityPolicy(env));
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(self), microphone=(self), geolocation=()');
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  headers.set('cross-origin-opener-policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/* L'app et l'API partagent le domaine ; ces en-têtes ne servent qu'aux
   configurations où le front serait hébergé ailleurs (Pages, aperçu local). */
function corsHeaders(request) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const preflight = (request) => new Response(null, { status: 204, headers: corsHeaders(request) });
