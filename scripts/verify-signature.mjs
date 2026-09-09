/**
 * Vérifie la signature AWS SigV4 du Worker.
 *
 * Les URL signées ne peuvent pas être éprouvées en local (il n'y a pas de clés
 * R2), et une signature fausse ne se verrait qu'en production, le jour du
 * mariage. Ce script compare donc la sortie de worker/s3.js à deux références
 * indépendantes :
 *   1. le vecteur de test officiel d'AWS pour la dérivation de clé ;
 *   2. une seconde implémentation, écrite ici avec node:crypto.
 *
 *   node scripts/verify-signature.mjs
 */

import { createHmac, createHash } from 'node:crypto';
import { presign, s3Config } from '../worker/s3.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}`);
  if (!ok) {
    failures++;
    console.log(`      attendu : ${expected}`);
    console.log(`      obtenu  : ${actual}`);
  }
};

/* ─── 1. Vecteur officiel AWS ──────────────────────────────────── */

const hmac = (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest();

function signingKey(secret, dateStamp, region, service) {
  let key = hmac(`AWS4${secret}`, dateStamp);
  key = hmac(key, region);
  key = hmac(key, service);
  return hmac(key, 'aws4_request');
}

console.log('\nDérivation de clé — vecteur de test AWS');
check(
  'signing key (iam / us-east-1 / 20150830)',
  signingKey(
    'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    '20150830',
    'us-east-1',
    'iam'
  ).toString('hex'),
  'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9'
);

/* ─── 2. Comparaison avec le module du Worker ──────────────────── */

const FIXED = new Date('2026-12-12T14:00:00.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    return args.length ? new RealDate(...args) : new RealDate(FIXED);
  }
  static now() { return FIXED.getTime(); }
};

const env = {
  S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  S3_ENDPOINT: 'https://abc123def456.r2.cloudflarestorage.com',
  S3_BUCKET: 'ouistitii-medias',
};
const cfg = s3Config(env);

const uriEncode = (str) =>
  encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encodePath = (path) => path.split('/').map(uriEncode).join('/');
const sha256 = (str) => createHash('sha256').update(str, 'utf8').digest('hex');
const canonicalQuery = (params) =>
  Object.keys(params).sort().map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`).join('&');

/** Référence : la spec AWS réécrite de zéro, sans regarder worker/s3.js. */
function referencePresign({ method, key, expiresIn, query = {}, contentType }) {
  const amzDate = FIXED.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const host = new URL(cfg.endpoint).host;

  const signedHeaders = contentType ? 'content-type;host' : 'host';
  const canonicalHeaders = contentType
    ? `content-type:${contentType}\nhost:${host}\n`
    : `host:${host}\n`;

  const params = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.S3_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaders,
  };

  const canonicalUri = encodePath(`/${cfg.bucket}/${key}`);
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery(params),
    canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(env.S3_SECRET_ACCESS_KEY, dateStamp, 'auto', 's3')
  ).update(stringToSign, 'utf8').digest('hex');

  return `${cfg.endpoint}${canonicalUri}?${canonicalQuery(params)}&X-Amz-Signature=${signature}`;
}

const cases = [
  {
    label: 'PUT simple, type de contenu signé',
    options: {
      method: 'PUT',
      key: 'mariage/2026-12-12/photos/marie-dupont/20261212-201455__a1b2c3d4__IMG_4821.jpg',
      expiresIn: 3600,
      contentType: 'image/jpeg',
    },
  },
  {
    label: 'PUT d’une partie (envoi fractionné)',
    options: {
      method: 'PUT',
      key: 'mariage/2026-12-12/videos/jean-baptiste-le-roy/20261212-231001__ff00aa11__VID_0004.mov',
      expiresIn: 3600,
      query: { partNumber: '3', uploadId: 'ABC+def/123=xyz' },
    },
  },
  {
    label: 'Clé accentuée et espaces (nom de fichier exotique)',
    options: {
      method: 'PUT',
      key: 'mariage/2026-12-12/photos/elodie-d-escarmain/20261212-201455__a1b2c3d4__Photo de Noel (1).jpg',
      expiresIn: 900,
      contentType: 'image/jpeg',
    },
  },
];

console.log('\nURL présignées — module du Worker vs implémentation de référence');
for (const { label, options } of cases) {
  check(label, await presign(cfg, options), referencePresign(options));
}

globalThis.Date = RealDate;

console.log(
  failures
    ? `\n${failures} écart(s) détecté(s).\n`
    : '\nSignature conforme : les URL directes vers R2 seront acceptées.\n'
);
process.exit(failures ? 1 : 0);
