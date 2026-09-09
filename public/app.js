/**
 * app.js — le parcours de l'invité.
 *
 *   Bienvenue → son nom → il ajoute, vérifie, retire → il envoie → c'est fini.
 *
 * Tout tient en une page : aucun rechargement, donc aucune sélection perdue.
 */

import * as api from './api.js';
import * as store from './store.js';
import { Uploader } from './uploader.js';
import {
  fingerprint, headBytes, makeThumb, inBatches, formatBytes, formatDuration,
} from './media-tools.js';

/* ─── État ─────────────────────────────────────────────────────── */

const state = {
  guest: null,      // { displayName, slug, sessionId, config }
  items: [],        // file d'attente vivante
  sending: false,
  screen: 'welcome',
};

let uploader = null;

const $ = (selector) => document.querySelector(selector);
const el = {
  screens: {},
  queue: $('#queue'),
  queueBlock: $('#queue-block'),
  queueCount: $('#queue-count'),
  dock: $('#dock'),
  dockStatus: $('#dock-status'),
  dockWeight: $('#dock-weight'),
  progress: $('#progress'),
  progressBar: $('#progress-bar'),
  btnSend: $('#btn-send'),
  btnSendLabel: $('#btn-send-label'),
  addError: $('#add-error'),
  addHint: $('#add-hint'),
  nameError: $('#name-error'),
};

/* ─── Navigation ───────────────────────────────────────────────── */

function show(name) {
  state.screen = name;
  for (const section of document.querySelectorAll('.screen')) {
    const active = section.id === `screen-${name}`;
    section.classList.toggle('active', active);
    section.classList.toggle('entering', active);
  }
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  document.querySelector(`#screen-${name} h1, #screen-${name} h2`)?.focus?.();
}

/* ─── Messages ─────────────────────────────────────────────────── */

/** `tone` : 'alert' pour ce qui coince, 'info' pour ce qui se contente d'informer. */
function notice(node, message, tone = 'alert') {
  if (!message) {
    node.hidden = true;
    return;
  }
  node.querySelector('span').textContent = message;
  node.classList.toggle('notice-alert', tone === 'alert');
  node.classList.toggle('notice-info', tone === 'info');
  node.hidden = false;
}

/* ─── Écran 1 · Bienvenue ──────────────────────────────────────── */

$('#btn-start').addEventListener('click', () => {
  show(state.guest ? 'add' : 'name');
});

/* ─── Écran 2 · Identification ─────────────────────────────────── */

$('#form-name').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#btn-name-next');
  const firstName = $('#first-name').value.trim();
  const lastName = $('#last-name').value.trim();

  $('#first-name').setAttribute('aria-invalid', firstName.length < 2);
  $('#last-name').setAttribute('aria-invalid', lastName.length < 1);

  if (firstName.length < 2 || lastName.length < 1) {
    notice(el.nameError, 'Merci d’indiquer votre prénom et votre nom.');
    return;
  }

  notice(el.nameError, null);
  button.disabled = true;
  button.textContent = 'Un instant…';

  try {
    const session = await api.openSession(firstName, lastName);
    state.guest = {
      displayName: session.contributor.displayName,
      slug: session.contributor.slug,
      sessionId: session.sessionId,
      config: session.config,
    };
    paintIdentity();
    await restoreQueue();
    show('add');
  } catch (error) {
    notice(el.nameError, error.message || 'Impossible d’ouvrir la session.');
  } finally {
    button.disabled = false;
    button.textContent = 'Continuer';
  }
});

function paintIdentity() {
  const name = state.guest?.displayName || '—';
  $('#who-name').textContent = name;
  $('#who-name-2').textContent = name;
}

$('#btn-swap').addEventListener('click', () => {
  const pendingCount = state.items.filter((i) => i.state !== 'stored').length;
  confirmDialog({
    title: 'Changer de personne',
    text: pendingCount
      ? `${pendingCount} souvenir${pendingCount > 1 ? 's' : ''} en attente ${
          pendingCount > 1 ? 'seront retirés' : 'sera retiré'
        } de la liste. Continuer ?`
      : 'Vous pourrez indiquer un autre prénom et un autre nom.',
    confirmLabel: 'Oui, changer',
    onConfirm: async () => {
      api.clearSession();
      await store.clear();
      state.items.forEach(releasePreview);
      state.items = [];
      state.guest = null;
      renderQueue();
      $('#first-name').value = '';
      $('#last-name').value = '';
      show('name');
    },
  });
});

/* ─── Écran 3 · Ajouter des souvenirs ──────────────────────────── */

const inputs = {
  photo: $('#input-photo'),
  video: $('#input-video'),
  gallery: $('#input-gallery'),
};

$('#btn-photo').addEventListener('click', () => openPicker('photo', 'camera'));
$('#btn-video').addEventListener('click', () => openPicker('video', 'camera'));
$('#btn-gallery').addEventListener('click', () => openPicker('gallery', 'gallery'));

/**
 * On délègue au téléphone : c'est lui qui demande la permission caméra et
 * affiche sa propre galerie. Rien à réinventer, rien à simuler.
 */
function openPicker(which, source) {
  const input = inputs[which];
  input.dataset.source = source;
  notice(el.addError, null);
  try {
    input.click();
  } catch {
    notice(el.addError, 'Votre navigateur a refusé l’ouverture. Essayez « Choisir dans ma galerie ».');
  }
}

for (const [which, input] of Object.entries(inputs)) {
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    const source = input.dataset.source || 'gallery';
    input.value = ''; // sans cela, reprendre deux fois la même photo ne déclenche rien
    if (!files.length) return;
    await addFiles(files, source, which);
  });
}

/* ─── Constitution de la file ──────────────────────────────────── */

const MAX_QUEUE = 400;

async function addFiles(files, source) {
  const config = state.guest?.config || {};
  const maxBytes = config.maxFileBytes || 600 * 1024 * 1024;

  if (state.items.length + files.length > MAX_QUEUE) {
    notice(
      el.addError,
      `Envoyez ces souvenirs d’abord : la liste accepte ${MAX_QUEUE} fichiers à la fois.`
    );
    files = files.slice(0, Math.max(0, MAX_QUEUE - state.items.length));
    if (!files.length) return;
  }

  const rejected = [];
  const accepted = [];

  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) { rejected.push(`${file.name} — format non accepté`); continue; }
    if (file.size === 0) { rejected.push(`${file.name} — fichier vide`); continue; }
    if (file.size > maxBytes) {
      rejected.push(`${file.name} — trop lourd (${formatBytes(file.size)})`);
      continue;
    }
    accepted.push({ file, kind });
  }

  if (rejected.length) {
    notice(
      el.addError,
      rejected.length === 1
        ? rejected[0]
        : `${rejected.length} fichiers écartés : ${rejected.slice(0, 2).join(' · ')}…`
    );
  }
  if (!accepted.length) return;

  el.addHint.hidden = true;
  setBusy(true, `Préparation de ${accepted.length} souvenir${accepted.length > 1 ? 's' : ''}…`);

  // Empreintes d'abord : elles écartent les doublons avant tout travail inutile.
  const prepared = [];
  await inBatches(accepted, 4, async ({ file, kind }) => {
    try {
      const fp = await fingerprint(file);
      prepared.push({ file, kind, fp });
    } catch {
      rejected.push(`${file.name} — illisible`);
    }
  });

  const seen = new Set(state.items.map((i) => i.fingerprint));
  const fresh = prepared.filter((p) => !seen.has(p.fp) && seen.add(p.fp));
  const localDuplicates = prepared.length - fresh.length;

  let alreadySent = new Set();
  try {
    const { known } = await api.checkFingerprints(fresh.map((p) => p.fp));
    alreadySent = new Set(known || []);
  } catch { /* sans réponse du serveur, on tentera l'envoi : le doublon sera détecté là */ }

  const added = [];
  for (const { file, kind, fp } of fresh) {
    const item = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      file,
      name: file.name || (kind === 'video' ? 'video.mp4' : 'photo.jpg'),
      size: file.size,
      mime: normalizeMime(file, kind),
      kind,
      fingerprint: fp,
      source,
      takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      state: alreadySent.has(fp) ? 'duplicate' : 'ready',
      progress: alreadySent.has(fp) ? 1 : 0,
      error: null,
      parts: [],
      addedAt: Date.now(),
      contributorSlug: state.guest?.slug || '',
    };
    state.items.push(item);
    added.push(item);
  }

  renderQueue();

  const skipped = localDuplicates + alreadySent.size;
  if (skipped) {
    notice(
      el.addError,
      skipped === 1
        ? 'Un souvenir était déjà dans la liste — il n’a pas été ajouté deux fois.'
        : `${skipped} souvenirs déjà présents ont été écartés.`,
      'info'
    );
  }

  // Le reste (octets d'en-tête, miniatures, sauvegarde locale) se fait en fond.
  setBusy(false);
  hydrate(added);
}

/** Travail de fond : en-tête pour la validation serveur, miniature, persistance. */
async function hydrate(items) {
  await store.persist();
  await inBatches(items, 3, async (item) => {
    try {
      item.head = await headBytes(item.file);
    } catch { /* le serveur refusera proprement */ }

    const thumb = await makeThumb(item.file, item.kind);
    if (thumb?.blob) item.thumbBlob = thumb.blob;
    if (thumb?.duration) item.duration = thumb.duration;

    paintTile(item);
    store.put(item);
  });
}

function kindOf(file) {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('image/')) return 'photo';
  if (type.startsWith('video/')) return 'video';
  // Certains Android laissent le type vide : on se rabat sur l'extension.
  const ext = (file.name || '').split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'avif'].includes(ext)) return 'photo';
  if (['mp4', 'mov', 'm4v', '3gp', 'webm', 'mkv'].includes(ext)) return 'video';
  return null;
}

function normalizeMime(file, kind) {
  const type = (file.type || '').toLowerCase();
  if (type) return type === 'image/jpg' ? 'image/jpeg' : type;
  const ext = (file.name || '').split('.').pop()?.toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic',
    heif: 'image/heif', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
    webm: 'video/webm', mkv: 'video/x-matroska',
  };
  return map[ext] || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
}

/* ─── Rendu de la file ─────────────────────────────────────────── */

function renderQueue() {
  const count = state.items.length;
  el.queueBlock.hidden = count === 0;
  el.dock.hidden = count === 0;
  el.addHint.hidden = count > 0;

  const fragment = document.createDocumentFragment();
  const existing = new Map([...el.queue.children].map((node) => [node.dataset.id, node]));

  for (const item of state.items) {
    const node = existing.get(item.id) || buildTile(item);
    existing.delete(item.id);
    fragment.appendChild(node);
    paintTile(item, node);
  }
  for (const orphan of existing.values()) orphan.remove();
  el.queue.appendChild(fragment);

  paintSummary();
}

function buildTile(item) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = item.id;
  tile.setAttribute('role', 'listitem');
  tile.innerHTML = `
    <div class="tile-fallback"><svg aria-hidden="true"><use href="#i-${
      item.kind === 'video' ? 'video' : 'gallery'
    }"></use></svg></div>
    <span class="tile-badge" ${item.kind === 'video' ? '' : 'hidden'}><svg aria-hidden="true"><use href="#i-video"></use></svg><span class="tile-dur"></span></span>
    <button class="tile-remove" type="button" aria-label="Retirer ce souvenir">
      <svg aria-hidden="true"><use href="#i-close"></use></svg>
    </button>
    <div class="tile-state"></div>
    <div class="tile-bar"><i></i></div>`;

  tile.querySelector('.tile-remove').addEventListener('click', () => removeItem(item.id));
  return tile;
}

function paintTile(item, node) {
  const tile = node || el.queue.querySelector(`[data-id="${item.id}"]`);
  if (!tile) return;

  tile.dataset.state = item.state;

  if (item.thumbBlob && !tile.querySelector('img')) {
    item.previewUrl = URL.createObjectURL(item.thumbBlob);
    const img = document.createElement('img');
    img.src = item.previewUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    tile.insertBefore(img, tile.firstChild);
    // Le pictogramme d'attente disparaît : sinon il recouvrirait la miniature.
    tile.querySelector('.tile-fallback')?.remove();
  }

  const badgeType = tile.querySelector('.tile-badge');
  if (badgeType) {
    badgeType.hidden = item.kind !== 'video';
    const duration = tile.querySelector('.tile-dur');
    if (duration) duration.textContent = formatDuration(item.duration);
  }

  const bar = tile.querySelector('.tile-bar i');
  if (bar) bar.style.width = `${Math.round((item.progress || 0) * 100)}%`;

  const badge = tile.querySelector('.tile-state');
  if (badge) {
    badge.innerHTML = stateIcon(item.state);
    badge.title = stateLabel(item);
  }

  tile.setAttribute(
    'aria-label',
    `${item.kind === 'video' ? 'Vidéo' : 'Photo'} — ${stateLabel(item)}`
  );
}

function stateIcon(state) {
  if (state === 'stored') return '<svg aria-hidden="true"><use href="#i-check"></use></svg>';
  if (state === 'failed') return '<svg aria-hidden="true"><use href="#i-alert"></use></svg>';
  if (state === 'duplicate') return '<svg aria-hidden="true"><use href="#i-copy"></use></svg>';
  return '';
}

function stateLabel(item) {
  switch (item.state) {
    case 'stored':    return 'envoyé';
    case 'failed':    return item.error || 'échec';
    case 'duplicate': return 'déjà envoyé';
    case 'uploading': return `envoi ${Math.round((item.progress || 0) * 100)} %`;
    case 'retrying':  return 'nouvel essai…';
    case 'preparing': return 'préparation';
    case 'queued':    return 'en attente';
    default:          return 'prêt à partir';
  }
}

function paintSummary() {
  const total = state.items.length;
  const photos = state.items.filter((i) => i.kind === 'photo').length;
  const videos = total - photos;
  const pending = state.items.filter((i) => i.state !== 'stored' && i.state !== 'duplicate');
  const bytes = pending.reduce((sum, i) => sum + i.size, 0);

  el.queueCount.textContent = total
    ? [
        photos ? `${photos} photo${photos > 1 ? 's' : ''}` : '',
        videos ? `${videos} vidéo${videos > 1 ? 's' : ''}` : '',
      ].filter(Boolean).join(' · ')
    : 'Aucun souvenir';

  el.dockWeight.textContent = bytes ? formatBytes(bytes) : '';
  el.btnSend.disabled = state.sending || pending.length === 0;
  el.btnSendLabel.textContent = pending.length
    ? `Envoyer ${pending.length} souvenir${pending.length > 1 ? 's' : ''}`
    : 'Tout est envoyé';

  if (!state.sending) {
    const failed = state.items.filter((i) => i.state === 'failed').length;
    el.dockStatus.textContent = failed
      ? `${failed} à réessayer`
      : pending.length
      ? 'Prêt à partir'
      : 'Tout est arrivé';
  }
}

/* ─── Retraits ─────────────────────────────────────────────────── */

function removeItem(id) {
  const index = state.items.findIndex((i) => i.id === id);
  if (index < 0) return;
  const [item] = state.items.splice(index, 1);

  const tile = el.queue.querySelector(`[data-id="${id}"]`);
  if (tile) {
    tile.classList.add('leaving');
    setTimeout(() => tile.remove(), 300);
  }
  releasePreview(item);
  store.remove(id);
  if (item.mediaId && item.state !== 'stored') api.failUpload(item.mediaId, 'retiré par l’invité', true);

  paintSummary();
  if (!state.items.length) renderQueue();
}

$('#btn-clear').addEventListener('click', () => {
  const pending = state.items.filter((i) => i.state !== 'stored');
  if (!pending.length) return;
  confirmDialog({
    title: 'Tout retirer',
    text: `Retirer ${pending.length} souvenir${pending.length > 1 ? 's' : ''} de la liste ? Les fichiers restent sur votre téléphone.`,
    confirmLabel: 'Oui, retirer',
    onConfirm: () => {
      for (const item of pending) removeItem(item.id);
    },
  });
});

function releasePreview(item) {
  if (item?.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
    item.previewUrl = null;
  }
}

/* ─── Envoi ────────────────────────────────────────────────────── */

el.btnSend.addEventListener('click', () => startSending());

async function startSending() {
  if (state.sending) return;
  const pending = state.items.filter((i) => i.state !== 'stored' && i.state !== 'duplicate');
  if (!pending.length) return;

  state.sending = true;
  el.progress.hidden = false;
  notice(el.addError, null);
  paintSummary();
  el.btnSend.disabled = true;

  uploader = new Uploader({
    concurrency: slowNetwork() ? 2 : 3,
    onItemChange: (item) => { paintTile(item); paintProgress(); store.put(item); },
    onProgress: () => paintProgress(),
  });

  window.addEventListener('beforeunload', warnBeforeLeaving);

  const summary = await uploader.run(state.items);

  window.removeEventListener('beforeunload', warnBeforeLeaving);
  state.sending = false;
  el.progress.hidden = true;
  paintSummary();

  await store.pruneStored();
  finishSending(summary);
}

function paintProgress() {
  const pending = state.items.filter((i) => i.state !== 'duplicate');
  const totalBytes = pending.reduce((sum, i) => sum + i.size, 0) || 1;
  const doneBytes = pending.reduce((sum, i) => sum + i.size * (i.progress || 0), 0);
  const ratio = Math.min(doneBytes / totalBytes, 1);

  el.progressBar.style.width = `${(ratio * 100).toFixed(1)}%`;

  const done = state.items.filter((i) => i.state === 'stored').length;
  const goal = state.items.filter((i) => i.state !== 'duplicate').length;
  el.dockStatus.textContent = `Envoi ${done} / ${goal}`;
  el.dockWeight.textContent = `${Math.round(ratio * 100)} %`;
}

function finishSending(summary) {
  const stored = state.items.filter((i) => i.state === 'stored');
  const failed = state.items.filter((i) => i.state === 'failed');
  const duplicates = state.items.filter((i) => i.state === 'duplicate');

  if (!stored.length && failed.length) {
    // Un format refusé ne repartira jamais : inutile d'inviter à réessayer.
    const hopeless = failed.every((i) => i.retryable === false);
    notice(
      el.addError,
      hopeless
        ? failed.length === 1
          ? `Ce fichier ne peut pas être envoyé : ${failed[0].error}. Retirez-le de la liste.`
          : `Ces ${failed.length} fichiers ne peuvent pas être envoyés. Retirez-les de la liste.`
        : failed.length === 1
        ? `Ce souvenir n’est pas parti : ${failed[0].error}. Réessayez.`
        : 'Aucun souvenir n’est parti. Vérifiez votre connexion puis réessayez.'
    );
    return;
  }

  $('#tally-photos').textContent = stored.filter((i) => i.kind === 'photo').length;
  $('#tally-videos').textContent = stored.filter((i) => i.kind === 'video').length;

  const partial = $('#done-partial');
  if (failed.length) {
    const hopeless = failed.every((i) => i.retryable === false);
    notice(
      partial,
      hopeless
        ? `${failed.length} fichier${failed.length > 1 ? 's ne sont' : ' n’est'} pas dans un format que nous pouvons garder. ${
            failed.length > 1 ? 'Ils restent' : 'Il reste'
          } dans la liste.`
        : `${failed.length} souvenir${failed.length > 1 ? 's n’ont' : ' n’a'} pas pu partir. ${
            failed.length > 1 ? 'Ils restent' : 'Il reste'
          } dans la liste : réessayez quand le réseau sera meilleur.`
    );
  } else {
    partial.hidden = true;
  }

  $('#done-text').textContent = duplicates.length
    ? 'Merci infiniment — les doublons ont été écartés au passage.'
    : 'Merci infiniment — nous les découvrirons avec émotion.';

  // Ce qui est arrivé quitte la liste ; ce qui a échoué y reste, réparable.
  for (const item of stored) {
    releasePreview(item);
    const tile = el.queue.querySelector(`[data-id="${item.id}"]`);
    tile?.remove();
  }
  state.items = state.items.filter((i) => i.state !== 'stored');
  renderQueue();

  show('done');
}

$('#btn-more').addEventListener('click', () => {
  notice($('#done-partial'), null);
  show('add');
});

const warnBeforeLeaving = (event) => {
  event.preventDefault();
  event.returnValue = '';
};

/** Sur un réseau annoncé lent, moins de transferts simultanés passent mieux. */
function slowNetwork() {
  const type = navigator.connection?.effectiveType;
  return type === 'slow-2g' || type === '2g' || type === '3g';
}

/* ─── Reprise après fermeture ──────────────────────────────────── */

async function restoreQueue() {
  const saved = await store.all();
  const mine = saved.filter(
    (item) => item.contributorSlug === state.guest?.slug && item.state !== 'stored'
  );
  if (!mine.length) return;

  for (const item of mine) {
    if (!(item.file instanceof Blob)) { store.remove(item.id); continue; }
    item.state = item.state === 'duplicate' ? 'duplicate' : 'ready';
    item.progress = item.state === 'duplicate' ? 1 : 0;
    item.plan = null;      // les URL signées ont expiré, on en redemandera
    item.parts = item.parts || [];
    state.items.push(item);
  }

  renderQueue();
  notice(
    el.addError,
    mine.length === 1
      ? 'Un souvenir vous attendait depuis votre dernière visite.'
      : `${mine.length} souvenirs vous attendaient depuis votre dernière visite.`,
    'info'
  );
}

/* ─── Réseau ───────────────────────────────────────────────────── */

window.addEventListener('offline', () => {
  notice(el.addError, 'Connexion perdue. Vos souvenirs sont conservés — l’envoi reprendra tout seul.');
});
window.addEventListener('online', () => {
  if (el.addError.textContent.includes('Connexion perdue')) notice(el.addError, null);
});

/* ─── Fenêtre de confirmation ──────────────────────────────────── */

const modal = $('#modal');
let modalAction = null;

function confirmDialog({ title, text, confirmLabel = 'Confirmer', onConfirm }) {
  $('#modal-title').textContent = title;
  $('#modal-text').textContent = text;
  $('#modal-confirm').textContent = confirmLabel;
  modalAction = onConfirm;
  modal.hidden = false;
  $('#modal-confirm').focus();
}

function closeModal() {
  modal.hidden = true;
  modalAction = null;
}

$('#modal-cancel').addEventListener('click', closeModal);
$('#modal-confirm').addEventListener('click', () => {
  const action = modalAction;
  closeModal();
  action?.();
});
modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modal.hidden) closeModal();
});

/* ─── Divers ───────────────────────────────────────────────────── */

function setBusy(busy, message) {
  el.btnSend.disabled = busy || state.sending;
  if (message) el.dockStatus.textContent = message;
  document.body.style.cursor = busy ? 'progress' : '';
}

/* ─── Démarrage ────────────────────────────────────────────────── */

(async function boot() {
  const saved = api.loadSession();
  if (saved && api.hasToken()) {
    state.guest = saved;
    paintIdentity();
    await restoreQueue();
  } else if (saved) {
    // Le jeton a expiré mais on connaît le nom : on le repropose.
    $('#first-name').value = saved.firstName || '';
    $('#last-name').value = saved.lastName || '';
  }
  document.body.dataset.ready = 'true';
})();
