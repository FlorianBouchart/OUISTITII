/**
 * media-tools.js — empreintes et miniatures.
 *
 * Deux exigences : ne jamais charger un fichier entier en mémoire (une vidéo
 * peut peser 300 Mo) et ne jamais bloquer le défilement, même quand un invité
 * ajoute deux cents photos d'un coup.
 */

const SAMPLE = 64 * 1024;   // octets lus en tête et en queue de fichier
const THUMB_SIZE = 240;     // côté de la miniature, en pixels

/* ─── Empreinte anti-doublon ───────────────────────────────────── */

/**
 * Empreinte d'un fichier sans le lire en entier : nom, taille, date, plus les
 * premiers et derniers kilo-octets. Deux photos différentes n'ont aucune chance
 * de partager tout cela ; la même photo choisie deux fois, si.
 */
export async function fingerprint(file) {
  const head = await file.slice(0, Math.min(SAMPLE, file.size)).arrayBuffer();
  const tail =
    file.size > SAMPLE
      ? await file.slice(Math.max(0, file.size - SAMPLE)).arrayBuffer()
      : new ArrayBuffer(0);

  const meta = new TextEncoder().encode(
    `${file.name}|${file.size}|${file.lastModified}|${file.type}`
  );

  const buffer = new Uint8Array(meta.length + head.byteLength + tail.byteLength);
  buffer.set(meta, 0);
  buffer.set(new Uint8Array(head), meta.length);
  buffer.set(new Uint8Array(tail), meta.length + head.byteLength);

  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Les 64 premiers octets, en base64 : le serveur vérifie le type réel. */
export async function headBytes(file) {
  const buffer = await file.slice(0, 64).arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ─── Miniatures ───────────────────────────────────────────────── */

const canRescale = typeof createImageBitmap === 'function';

export async function makeThumb(file, kind) {
  try {
    return kind === 'video' ? await videoThumb(file) : await imageThumb(file);
  } catch {
    return null; // une icône de repli suffira
  }
}

async function imageThumb(file) {
  let bitmap;
  if (canRescale) {
    try {
      bitmap = await createImageBitmap(file, {
        resizeWidth: THUMB_SIZE,
        resizeHeight: THUMB_SIZE,
        resizeQuality: 'low',
      });
    } catch {
      bitmap = await createImageBitmap(file); // certains formats refusent le redimensionnement
    }
  } else {
    bitmap = await bitmapFromElement(file);
  }

  const blob = await drawToBlob(bitmap);
  bitmap.close?.();
  return { blob };
}

async function videoThumb(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = url;

  try {
    const duration = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 6000);
      video.onloadedmetadata = () => { clearTimeout(timer); resolve(video.duration); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('metadata')); };
    });

    // Une image prise un peu après le début : la toute première est souvent noire.
    const frame = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 6000);
      video.onseeked = () => { clearTimeout(timer); resolve(true); };
      video.currentTime = Math.min(0.4, (duration || 1) / 3);
    });

    if (!frame || !video.videoWidth) return { blob: null, duration };

    const side = Math.min(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    canvas.getContext('2d').drawImage(
      video,
      (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side,
      0, 0, THUMB_SIZE, THUMB_SIZE
    );
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
    return { blob, duration };
  } finally {
    video.removeAttribute('src');
    video.load?.();
    URL.revokeObjectURL(url);
  }
}

async function drawToBlob(bitmap) {
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_SIZE;
  canvas.height = THUMB_SIZE;
  canvas.getContext('2d').drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, THUMB_SIZE, THUMB_SIZE
  );
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
}

function bitmapFromElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    image.src = url;
  });
}

/* ─── Cadence ──────────────────────────────────────────────────── */

/**
 * Traite une liste par petits groupes, en rendant la main au navigateur entre
 * chacun : l'interface reste fluide même sur deux cents fichiers.
 */
export async function inBatches(items, size, worker) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(worker));
    await yieldToBrowser();
  }
}

/**
 * Rend la main entre deux groupes. On attend une image écran quand il y en a
 * une, mais jamais plus de 50 ms : téléphone verrouillé ou onglet en arrière-plan,
 * `requestAnimationFrame` ne se déclenche plus du tout — et la préparation
 * resterait figée jusqu'au retour de l'invité.
 */
function yieldToBrowser() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}

export function formatBytes(n) {
  if (!n) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
