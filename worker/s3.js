/**
 * s3.js — signature AWS SigV4 pour l'API S3 de Cloudflare R2.
 *
 * Deux usages :
 *   • presign()      → une URL signée, à durée de vie courte, que le téléphone
 *                      utilise pour déposer un fichier DIRECTEMENT dans R2.
 *                      Aucun octet du média ne traverse le Worker.
 *   • signedFetch()  → un appel serveur → R2 (ouverture / clôture d'un envoi
 *                      fractionné, suppression). Corps minuscules, jamais de média.
 *
 * Écrit à la main avec l'API Web Crypto : pas de SDK, pas de dépendance,
 * quelques kilo-octets de bundle.
 */

const ENCODER = new TextEncoder();
const SERVICE = 's3';
const REGION = 'auto'; // R2 n'a qu'une région logique

/* ─── Primitives cryptographiques ──────────────────────────────── */

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key instanceof Uint8Array ? key : ENCODER.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, ENCODER.encode(message)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(payload) {
  const data = typeof payload === 'string' ? ENCODER.encode(payload) : payload;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

/** Encodage RFC 3986 : plus strict qu'encodeURIComponent (! ' ( ) * inclus). */
function uriEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** Le chemin est encodé segment par segment : les « / » restent des séparateurs. */
const encodePath = (path) => path.split('/').map(uriEncode).join('/');

function amzDates(date = new Date()) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261212T140000Z
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

async function derivedKey(secretKey, dateStamp) {
  let key = await hmac(`AWS4${secretKey}`, dateStamp);
  key = await hmac(key, REGION);
  key = await hmac(key, SERVICE);
  return hmac(key, 'aws4_request');
}

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join('&');
}

/* ─── Configuration ────────────────────────────────────────────── */

/**
 * Lit la configuration S3 dans les secrets du Worker.
 * Renvoie null si elle est absente : l'application bascule alors en mode
 * « relais » (dépôt via le Worker), ce qui permet de développer en local
 * sans la moindre clé.
 */
export function s3Config(env) {
  const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT } = env;
  if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !S3_ENDPOINT) return null;
  const endpoint = String(S3_ENDPOINT).replace(/\/+$/, '');
  return {
    accessKey: S3_ACCESS_KEY_ID,
    secretKey: S3_SECRET_ACCESS_KEY,
    endpoint,
    host: new URL(endpoint).host,
    bucket: env.S3_BUCKET || 'ouistitii-medias',
  };
}

/* ─── URL présignée (le téléphone parle à R2 en direct) ────────── */

/**
 * @param {object} cfg      résultat de s3Config()
 * @param {object} options  { method, key, expiresIn, query, contentType }
 * @returns {Promise<string>} URL signée
 */
export async function presign(cfg, { method = 'PUT', key, expiresIn = 3600, query = {}, contentType }) {
  const { amzDate, dateStamp } = amzDates();
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  // Le type de contenu est signé : le téléphone ne peut pas déposer un
  // exécutable sous une URL obtenue pour une photo.
  const signedHeaders = contentType ? 'content-type;host' : 'host';
  const canonicalHeaders = contentType
    ? `content-type:${contentType}\nhost:${cfg.host}\n`
    : `host:${cfg.host}\n`;

  const params = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKey}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaders,
  };

  const canonicalUri = encodePath(`/${cfg.bucket}/${key}`);
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(params),
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = toHex(await hmac(await derivedKey(cfg.secretKey, dateStamp), stringToSign));

  return `${cfg.endpoint}${canonicalUri}?${canonicalQuery(params)}&X-Amz-Signature=${signature}`;
}

/* ─── Requête signée (Worker → R2) ─────────────────────────────── */

export async function signedFetch(cfg, { method = 'GET', key = '', query = {}, body = '', contentType }) {
  const { amzDate, dateStamp } = amzDates();
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const payloadHash = await sha256Hex(body || '');

  const headers = {
    host: cfg.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalUri = encodePath(`/${cfg.bucket}${key ? `/${key}` : ''}`);
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = toHex(await hmac(await derivedKey(cfg.secretKey, dateStamp), stringToSign));

  const url = `${cfg.endpoint}${canonicalUri}${
    Object.keys(query).length ? `?${canonicalQuery(query)}` : ''
  }`;

  const requestHeaders = { ...headers };
  delete requestHeaders.host; // fetch pose l'en-tête Host lui-même
  requestHeaders.authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, { method, headers: requestHeaders, body: body || undefined });
}

/* ─── Envoi fractionné (fichiers lourds, reprise possible) ─────── */

export async function createMultipartUpload(cfg, key, contentType) {
  const res = await signedFetch(cfg, { method: 'POST', key, query: { uploads: '' }, contentType });
  if (!res.ok) throw new Error(`R2 CreateMultipartUpload ${res.status}: ${await res.text()}`);
  const xml = await res.text();
  const uploadId = xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error('R2 : identifiant d’envoi fractionné introuvable');
  return uploadId;
}

export function presignPart(cfg, key, uploadId, partNumber, expiresIn = 3600) {
  return presign(cfg, {
    method: 'PUT',
    key,
    expiresIn,
    query: { partNumber: String(partNumber), uploadId },
  });
}

export async function completeMultipartUpload(cfg, key, uploadId, parts) {
  const xml =
    '<CompleteMultipartUpload>' +
    parts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(
        (p) =>
          `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`
      )
      .join('') +
    '</CompleteMultipartUpload>';

  const res = await signedFetch(cfg, {
    method: 'POST',
    key,
    query: { uploadId },
    body: xml,
    contentType: 'application/xml',
  });
  const text = await res.text();
  // S3 peut répondre 200 en emballant une erreur dans le corps XML.
  if (!res.ok || /<Error>/.test(text)) {
    throw new Error(`R2 CompleteMultipartUpload ${res.status}: ${text.slice(0, 300)}`);
  }
  return true;
}

export async function abortMultipartUpload(cfg, key, uploadId) {
  const res = await signedFetch(cfg, { method: 'DELETE', key, query: { uploadId } });
  return res.ok || res.status === 404;
}

function escapeXml(str) {
  return String(str).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])
  );
}
