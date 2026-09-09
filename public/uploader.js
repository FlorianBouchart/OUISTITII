/**
 * uploader.js — le moteur d'envoi.
 *
 * Ce qu'il garantit, dans une salle de fête où le réseau va et vient :
 *   • chaque fichier vit sa propre vie — un échec n'emporte pas les autres ;
 *   • les fichiers lourds partent en morceaux, et reprennent où ils en étaient ;
 *   • une coupure met l'envoi en pause, le retour du réseau le relance ;
 *   • rien n'est marqué « arrivé » tant que le stockage ne l'a pas confirmé.
 */

import * as api from './api.js';

const MAX_ATTEMPTS = 4;
const PART_URL_BATCH = 12;

export class Uploader {
  constructor({ onItemChange, onProgress, concurrency = 3 } = {}) {
    this.onItemChange = onItemChange || (() => {});
    this.onProgress = onProgress || (() => {});
    this.concurrency = concurrency;
    this.running = false;
    this.stopped = false;
    this.controllers = new Set();
  }

  /** Envoie tout ce qui n'est pas encore arrivé. Ne rend la main qu'à la fin. */
  async run(items) {
    if (this.running) return null;
    this.running = true;
    this.stopped = false;

    const pending = items.filter((item) => item.state !== 'stored' && item.state !== 'duplicate');
    pending.forEach((item) => {
      item.state = 'queued';
      item.error = null;
      this.onItemChange(item);
    });

    const queue = pending.slice();
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, () =>
      this.worker(queue)
    );
    await Promise.all(workers);

    this.running = false;
    return {
      stored: pending.filter((i) => i.state === 'stored').length,
      duplicates: pending.filter((i) => i.state === 'duplicate').length,
      failed: pending.filter((i) => i.state === 'failed').length,
      stopped: this.stopped,
    };
  }

  stop() {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  async worker(queue) {
    while (queue.length && !this.stopped) {
      const item = queue.shift();
      try {
        await this.send(item);
      } catch (error) {
        item.state = 'failed';
        item.error = error?.message || 'Envoi impossible';
        this.onItemChange(item);
      }
    }
  }

  /* ─── Cycle de vie d'un fichier ──────────────────────────────── */

  async send(item) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.stopped) return;
      try {
        await waitForNetwork();
        await this.attempt(item);
        return;
      } catch (error) {
        if (this.stopped || error?.name === 'AbortError') return;

        const fatal = isFatal(error);
        const last = attempt === MAX_ATTEMPTS;

        if (fatal || last) {
          item.state = 'failed';
          item.error = friendly(error);
          item.retryable = !fatal;
          this.onItemChange(item);
          if (item.mediaId) api.failUpload(item.mediaId, String(error?.message || '').slice(0, 180));
          return;
        }

        item.state = 'retrying';
        item.attempt = attempt;
        this.onItemChange(item);
        await delay(backoff(attempt));
      }
    }
  }

  async attempt(item) {
    if (!item.plan) {
      item.state = 'preparing';
      this.onItemChange(item);

      const plan = await api.initUpload({
        fingerprint: item.fingerprint,
        name: item.name,
        size: item.size,
        mime: item.mime,
        head: item.head,
        source: item.source,
        takenAt: item.takenAt,
      });

      if (plan.duplicate) {
        item.state = 'duplicate';
        item.mediaId = plan.mediaId;
        item.progress = 1;
        this.onItemChange(item);
        return;
      }

      item.mediaId = plan.mediaId;
      item.plan = plan;
      if (!item.parts) item.parts = [];
    }

    item.state = 'uploading';
    this.onItemChange(item);

    if (item.plan.multipart) {
      await this.sendParts(item);
    } else {
      await this.sendWhole(item);
    }

    const result = await api.completeUpload(item.mediaId, item.parts || []);
    item.state = 'stored';
    item.progress = 1;
    item.storedSize = result?.size ?? item.size;
    this.onItemChange(item);
  }

  /* ─── Fichier d'une seule pièce ──────────────────────────────── */

  async sendWhole(item) {
    const onProgress = (loaded) => {
      item.progress = Math.min(loaded / item.size, 0.99);
      this.onProgress(item);
    };

    if (item.plan.url) {
      await this.xhrSend('PUT', item.plan.url, item.file, {
        headers: { 'content-type': item.mime },
        onProgress,
      });
    } else {
      await this.xhrSend('PUT', api.relayUrl(item.mediaId), item.file, {
        headers: { 'content-type': item.mime, ...api.authHeader() },
        onProgress,
      });
    }
    item.progress = 0.99;
    this.onProgress(item);
  }

  /* ─── Fichier découpé en morceaux ────────────────────────────── */

  async sendParts(item) {
    const { partSize, partsTotal } = item.plan;
    const done = new Map((item.parts || []).map((p) => [p.partNumber, p.etag]));
    let urls = { ...(item.plan.urls || {}) };

    const sentBytes = () => done.size * partSize;

    for (let n = 1; n <= partsTotal; n++) {
      if (this.stopped) throw new DOMException('Envoi interrompu', 'AbortError');
      if (done.has(n)) continue;

      // Les URL signées sont demandées par petits paquets, jamais toutes d'avance.
      if (!urls[n] && item.plan.transport === 'direct') {
        const wanted = [];
        for (let k = n; k < Math.min(n + PART_URL_BATCH, partsTotal + 1); k++) {
          if (!done.has(k)) wanted.push(k);
        }
        const fresh = await api.morePartUrls(item.mediaId, wanted);
        urls = { ...urls, ...(fresh.urls || {}) };
      }

      const start = (n - 1) * partSize;
      const chunk = item.file.slice(start, Math.min(start + partSize, item.size));

      const onProgress = (loaded) => {
        item.progress = Math.min((sentBytes() + loaded) / item.size, 0.99);
        this.onProgress(item);
      };

      const response = urls[n]
        ? await this.xhrSend('PUT', urls[n], chunk, { onProgress })
        : await this.xhrSend('PUT', api.relayUrl(item.mediaId, n), chunk, {
            headers: api.authHeader(),
            onProgress,
          });

      const etag = extractEtag(response);
      if (!etag) throw new Error('Réponse incomplète du stockage');

      done.set(n, etag);
      item.parts = [...done].map(([partNumber, tag]) => ({ partNumber, etag: tag }));
      item.progress = Math.min(sentBytes() / item.size, 0.99);
      this.onProgress(item);
    }
  }

  /* ─── Transport bas niveau ───────────────────────────────────── */

  /** XHR plutôt que fetch : c'est le seul moyen de suivre l'octet qui monte. */
  xhrSend(method, url, body, { headers = {}, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const controller = { abort: () => xhr.abort() };
      this.controllers.add(controller);

      xhr.open(method, url, true);
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
      xhr.timeout = 15 * 60 * 1000; // une vidéo lourde sur un réseau lent

      if (onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) onProgress(event.loaded);
        };
      }

      const finish = (fn) => (...args) => {
        this.controllers.delete(controller);
        fn(...args);
      };

      xhr.onload = finish(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({
            etagHeader: xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag'),
            body: xhr.responseText,
            status: xhr.status,
          });
        } else {
          const error = new Error(`Transfert refusé (${xhr.status})`);
          error.status = xhr.status;
          reject(error);
        }
      });
      xhr.onerror = finish(() => reject(new Error('Connexion interrompue')));
      xhr.ontimeout = finish(() => reject(new Error('Le transfert a pris trop de temps')));
      xhr.onabort = finish(() => reject(new DOMException('Envoi interrompu', 'AbortError')));

      xhr.send(body);
    });
  }
}

/* ─── Utilitaires ──────────────────────────────────────────────── */

function extractEtag(response) {
  if (response.etagHeader) return response.etagHeader.replace(/^"|"$/g, '');
  // Mode relais : le Worker renvoie l'empreinte dans le corps.
  try {
    return JSON.parse(response.body || '{}').etag?.replace(/^"|"$/g, '') || null;
  } catch {
    return null;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attente croissante, avec un grain d'aléatoire pour ne pas repartir en meute. */
const backoff = (attempt) => Math.min(1200 * 2 ** (attempt - 1), 12000) + Math.random() * 600;

/** Inutile de brûler des tentatives hors réseau : on attend son retour. */
function waitForNetwork() {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => {
    const onBack = () => { window.removeEventListener('online', onBack); resolve(); };
    window.addEventListener('online', onBack);
    setTimeout(onBack, 20000); // filet de sécurité : navigator.onLine ment parfois
  });
}

/** Erreurs sans espoir de réussite en réessayant. */
function isFatal(error) {
  const code = error?.code;
  if (['unsupported_type', 'content_mismatch', 'file_too_large', 'size_mismatch'].includes(code)) {
    return true;
  }
  return error?.status === 413 || error?.status === 415;
}

function friendly(error) {
  if (error?.code === 'file_too_large') return 'Fichier trop lourd';
  if (error?.code === 'unsupported_type') return 'Format non accepté';
  if (error?.code === 'content_mismatch') return 'Fichier illisible';
  if (error?.code === 'session_expired') return 'Session expirée';
  if (error?.code === 'network' || error?.status === 0) return 'Réseau interrompu';
  return error?.message || 'Envoi impossible';
}
