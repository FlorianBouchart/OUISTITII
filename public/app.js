/**
 * app.js — le parcours de l'invité.
 *
 *   Bienvenue → son nom → il ajoute, vérifie, retire → il envoie → l'album
 *
 * Tout tient en une page : aucun rechargement, donc aucune sélection perdue.
 * Chaque passage d'un écran à l'autre est couvert par la queue du ouistiti.
 */

import * as api from './api.js';
import * as store from './store.js';
import { Uploader } from './uploader.js';
import {
  fingerprint, headBytes, makeThumb, readPixelSize, inBatches, formatBytes, formatDuration,
} from './media-tools.js';
import {
  canShareFiles, prepareFiles, shareFiles, downloadFile, totalBytes, BATCH,
} from './export.js';
import {
  curtain, riseIn, spellOut, Mascot, flash, dropIn, flyOut, popSay,
  magnetize, countTo, drawSeal, reducedMotion,
} from './motion.js';

/* ─── État ─────────────────────────────────────────────────────── */

const state = {
  guest: null,
  items: [],
  sending: false,
  screen: 'welcome',
  gallery: { items: [], offset: 0, filter: '', total: 0, loading: false, done: false },
  picking: false,
  picked: new Set(),
};

let uploader = null;
let mascots = [];

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const el = {
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
  mosaic: $('#mosaic'),
};

/* ─── Navigation ───────────────────────────────────────────────── */

const CURTAIN_WORDS = {
  add: 'Ouistiti !',
  gallery: 'L’album',
  done: 'Merci',
  welcome: 'OUISTITII',
};

/** Change d'écran derrière le rideau. */
function go(name, { silent = false, word } = {}) {
  if (state.screen === name) return Promise.resolve();
  const swap = () => paintScreen(name);
  return silent || reducedMotion()
    ? Promise.resolve(swap())
    : curtain(swap, { word: word || CURTAIN_WORDS[name] || '' });
}

function paintScreen(name) {
  state.screen = name;
  for (const section of $$('.screen')) {
    section.classList.toggle('active', section.id === `screen-${name}`);
  }
  window.scrollTo(0, 0);

  const screen = $(`#screen-${name}`);
  if (screen) riseIn(screen, { delay: 0.06 });

  if (name === 'welcome') {
    spellOut($('.wordmark-letters'), { delay: 0.1 });
    onNameInput();
  }
  if (name === 'gallery') loadGallery({ reset: true });
  if (name === 'done') drawSeal($('#done-seal-svg'));

  // L'onglet suit l'écran affiché.
  for (const tabs of $$('.tabs')) {
    tabs.dataset.on = name === 'gallery' ? 'gallery' : 'add';
  }
}

/* ─── Messages ─────────────────────────────────────────────────── */

/** `tone` : 'alert' pour ce qui coince, 'info' pour ce qui se contente d'informer. */
function notice(node, message, tone = 'alert') {
  if (!node) return;
  if (!message) { node.hidden = true; return; }
  node.querySelector('span').textContent = message;
  node.classList.toggle('notice-alert', tone === 'alert');
  node.classList.toggle('notice-info', tone === 'info');
  // Un point d'exclamation sur une simple information donnerait l'alerte à tort.
  node.querySelector('use')?.setAttribute('href', tone === 'info' ? '#i-info' : '#i-alert');
  node.hidden = false;
}

/* ─── La mascotte ──────────────────────────────────────────────── */

function plantMascots() {
  const template = $('#tpl-ouistiti');
  for (const host of [$('#welcome-mascot'), $('#name-mascot')]) {
    if (!host || host.childElementCount) continue;
    host.appendChild(template.content.cloneNode(true));
    mascots.push(new Mascot(host.querySelector('.oui')));
  }
}

const cheer = () => mascots.forEach((m) => m.cheer());
const grin = () => mascots.forEach((m) => m.grin());

/* ─── Écran 1 · Bienvenue ──────────────────────────────────────── */

/* ─── Écran 2 · Identification ─────────────────────────────────── */

const firstNameField = $('#first-name');
const lastNameField = $('#last-name');

/** La saisie fait vivre l'écran : trait qui se remplit, signature qui se trace. */
function onNameInput() {
  const first = firstNameField.value.trim();
  const last = lastNameField.value.trim();

  // Le nom s'écrit en direct, en script : l'invité voit sa signature se former.
  const full = [first, last].filter(Boolean).join(' ');
  $('#signature-name').textContent = full || '\u00A0';
  $('#btn-name-next').classList.toggle('is-ready', first.length >= 2 && last.length >= 1);

  // Le ouistiti suit ce qu'on écrit du regard.
  mascots.forEach((m) => m.look(Math.min((first.length + last.length) / 16, 1)));
}


for (const field of [firstNameField, lastNameField]) {
  field.addEventListener('input', onNameInput);
  field.addEventListener('focus', onNameInput);
}

$('#form-name').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#btn-name-next');
  const firstName = firstNameField.value.trim();
  const lastName = lastNameField.value.trim();

  firstNameField.setAttribute('aria-invalid', firstName.length < 2);
  lastNameField.setAttribute('aria-invalid', lastName.length < 1);

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
    grin();
    await restoreQueue();
    await go('add', { word: 'Ouistiti !' });
  } catch (error) {
    notice(el.nameError, error.message || 'Impossible d’ouvrir la session.');
  } finally {
    button.disabled = false;
    button.textContent = 'Envoyer mes souvenirs';
  }
});

function paintIdentity() {
  const name = state.guest?.displayName || '—';
  for (const id of ['#who-name', '#who-name-2', '#who-name-3']) {
    const node = $(id);
    if (node) node.textContent = name;
  }
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
      firstNameField.value = '';
      lastNameField.value = '';
      onNameInput();
      await go('welcome');
    },
  });
});

/* ─── Onglets ──────────────────────────────────────────────────── */

for (const id of ['#tab-add', '#tab-add-2']) $(id)?.addEventListener('click', () => go('add'));
for (const id of ['#tab-gallery', '#tab-gallery-2']) $(id)?.addEventListener('click', () => go('gallery'));

/* ─── Écran 3 · Ajouter ────────────────────────────────────────── */

const inputs = {
  photo: $('#input-photo'),
  video: $('#input-video'),
  gallery: $('#input-gallery'),
};

$('#btn-photo').addEventListener('click', () => openPicker('photo', 'camera'));
$('#btn-video').addEventListener('click', () => openPicker('video', 'camera'));
$('#btn-gallery').addEventListener('click', () => openPicker('gallery', 'gallery'));

/** Le halo suit le doigt sur les tuiles d'ajout. */
for (const tile of $$('.add-tile')) {
  const glow = tile.querySelector('.add-tile-glow');
  tile.addEventListener('pointermove', (event) => {
    const box = tile.getBoundingClientRect();
    glow.style.left = `${event.clientX - box.left}px`;
    glow.style.top = `${event.clientY - box.top}px`;
  });
}

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

for (const input of Object.values(inputs)) {
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    const source = input.dataset.source || 'gallery';
    input.value = ''; // sans cela, reprendre deux fois la même photo ne déclenche rien
    if (!files.length) return;
    await addFiles(files, source);
  });
}

/* ─── Constitution de la file ──────────────────────────────────── */

const MAX_QUEUE = 400;

async function addFiles(files, source) {
  const config = state.guest?.config || {};
  const maxBytes = config.maxFileBytes || 600 * 1024 * 1024;

  if (state.items.length + files.length > MAX_QUEUE) {
    notice(el.addError, `Envoyez ces souvenirs d’abord : la liste accepte ${MAX_QUEUE} fichiers à la fois.`);
    files = files.slice(0, Math.max(0, MAX_QUEUE - state.items.length));
    if (!files.length) return;
  }

  const rejected = [];
  const accepted = [];

  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) { rejected.push(`${file.name} — format non accepté`); continue; }
    if (file.size === 0) { rejected.push(`${file.name} — fichier vide`); continue; }
    if (file.size > maxBytes) { rejected.push(`${file.name} — trop lourd (${formatBytes(file.size)})`); continue; }
    accepted.push({ file, kind });
  }

  if (rejected.length) {
    notice(
      el.addError,
      rejected.length === 1 ? rejected[0] : `${rejected.length} fichiers écartés : ${rejected.slice(0, 2).join(' · ')}…`
    );
  }
  if (!accepted.length) return;

  el.addHint.hidden = true;
  setBusy(true, `Préparation de ${accepted.length} souvenir${accepted.length > 1 ? 's' : ''}…`);

  // Empreintes d'abord : elles écartent les doublons avant tout travail inutile.
  const prepared = [];
  await inBatches(accepted, 4, async ({ file, kind }) => {
    try {
      prepared.push({ file, kind, fp: await fingerprint(file) });
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
  } catch { /* sans réponse du serveur, on tentera l'envoi : le doublon sera vu là */ }

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
      // Le laisser-aller du polaroïd qu'on pose sur la table. On écarte les
      // valeurs proches de zéro : une vignette « presque droite » ne se lit pas
      // comme un choix, elle se lit comme un défaut d'alignement.
      tilt: ((Math.random() < 0.5 ? -1 : 1) * (1.7 + Math.random() * 2.6)).toFixed(2),
      addedAt: Date.now(),
      contributorSlug: state.guest?.slug || '',
    };
    state.items.push(item);
    added.push(item);
  }

  renderQueue({ animateFrom: state.items.length - added.length });
  if (added.length) cheer();

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

  setBusy(false);
  hydrate(added);
}

/** Travail de fond : octets d'en-tête, miniature, persistance. */
async function hydrate(items) {
  await store.persist();
  await inBatches(items, 3, async (item) => {
    try {
      item.head = await headBytes(item.file);
    } catch { /* le serveur refusera proprement */ }

    const thumb = await makeThumb(item.file, item.kind);
    if (thumb?.blob) item.thumbBlob = thumb.blob;
    if (thumb?.duration) item.duration = thumb.duration;

    // Les vraies dimensions : en-tête du fichier pour une photo, piste vidéo sinon.
    const size = item.kind === 'video'
      ? (thumb?.width ? { width: thumb.width, height: thumb.height } : null)
      : await readPixelSize(item.file);
    if (size) { item.width = size.width; item.height = size.height; }

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

function renderQueue({ animateFrom = null } = {}) {
  const count = state.items.length;
  el.queueBlock.hidden = count === 0;
  el.dock.hidden = count === 0;
  el.addHint.hidden = count > 0;

  const fragment = document.createDocumentFragment();
  const existing = new Map([...el.queue.children].map((node) => [node.dataset.id, node]));
  const fresh = [];

  for (const item of state.items) {
    let node = existing.get(item.id);
    if (!node) { node = buildTile(item); fresh.push(node); }
    existing.delete(item.id);
    fragment.appendChild(node);
    paintTile(item, node);
  }
  for (const orphan of existing.values()) orphan.remove();
  el.queue.appendChild(fragment);

  if (fresh.length && animateFrom !== null) dropIn(fresh);
  paintSummary();
}

function buildTile(item) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = item.id;
  tile.dataset.tilt = item.tilt || 0;
  // Posé tout de suite : une vignette rendue hors animation doit déjà pencher.
  tile.style.transform = `rotate(${item.tilt || 0}deg)`;
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

  const before = tile.dataset.state;
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

  const badge = tile.querySelector('.tile-badge');
  if (badge) {
    badge.hidden = item.kind !== 'video';
    const duration = tile.querySelector('.tile-dur');
    if (duration) duration.textContent = formatDuration(item.duration);
  }

  const bar = tile.querySelector('.tile-bar i');
  if (bar) bar.style.width = `${Math.round((item.progress || 0) * 100)}%`;

  const stamp = tile.querySelector('.tile-state');
  if (stamp) {
    stamp.innerHTML = stateIcon(item.state);
    stamp.title = stateLabel(item);
  }

  // Le flash du photographe, à l'instant où le souvenir est arrivé.
  if (before !== 'stored' && item.state === 'stored') flash(tile);

  tile.setAttribute('aria-label', `${item.kind === 'video' ? 'Vidéo' : 'Photo'} — ${stateLabel(item)}`);
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
      : pending.length ? 'Prêt à partir' : 'Tout est arrivé';
  }
}

/* ─── Retraits ─────────────────────────────────────────────────── */

async function removeItem(id) {
  const index = state.items.findIndex((i) => i.id === id);
  if (index < 0) return;
  const [item] = state.items.splice(index, 1);

  const tile = el.queue.querySelector(`[data-id="${id}"]`);
  if (tile) await flyOut(tile);

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
    onConfirm: () => { for (const item of pending) removeItem(item.id); },
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
  popSay('Ouistiti !');

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
  await finishSending(summary);
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

async function finishSending() {
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

  const photos = stored.filter((i) => i.kind === 'photo').length;
  const videos = stored.length - photos;

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
    el.queue.querySelector(`[data-id="${item.id}"]`)?.remove();
  }
  state.items = state.items.filter((i) => i.state !== 'stored');
  renderQueue();
  state.gallery.done = false; // l'album a de quoi se rafraîchir

  await go('done');
  countTo($('#tally-photos'), photos);
  countTo($('#tally-videos'), videos);
  grin();
}

$('#btn-more').addEventListener('click', () => {
  notice($('#done-partial'), null);
  go('add');
});
$('#btn-see-gallery').addEventListener('click', () => go('gallery'));

const warnBeforeLeaving = (event) => { event.preventDefault(); event.returnValue = ''; };

/** Sur un réseau annoncé lent, moins de transferts simultanés passent mieux. */
function slowNetwork() {
  const type = navigator.connection?.effectiveType;
  return type === 'slow-2g' || type === '2g' || type === '3g';
}

/* ═══════════════════════════════════════════════════════════════
   L'ALBUM PARTAGÉ
   ═══════════════════════════════════════════════════════════════ */

for (const chip of $$('.chip')) {
  chip.addEventListener('click', () => {
    for (const other of $$('.chip')) other.classList.toggle('is-on', other === chip);
    state.gallery.filter = chip.dataset.filter || '';
    loadGallery({ reset: true });
  });
}

$('#btn-gallery-more').addEventListener('click', () => loadGallery({ reset: false }));

async function loadGallery({ reset }) {
  const g = state.gallery;
  if (g.loading) return;
  if (reset) { g.offset = 0; g.items = []; g.done = false; el.mosaic.innerHTML = ''; }
  if (g.done) return;

  g.loading = true;
  notice($('#gallery-error'), null);
  if (reset) showSkeletons(9);

  try {
    const data = await api.gallery({ offset: g.offset, limit: 48, filter: g.filter });
    if (reset) el.mosaic.innerHTML = '';

    g.items.push(...data.items);
    g.offset += data.items.length;
    g.total = data.total;
    g.done = data.items.length < data.limit;

    const fragment = document.createDocumentFragment();
    const fresh = [];
    for (const item of data.items) {
      const node = buildShot(item);
      fresh.push(node);
      fragment.appendChild(node);
    }
    el.mosaic.appendChild(fragment);
    dropIn(fresh);

    $('#btn-gallery-more').hidden = g.done;
    paintKeepsafe();
    $('#gallery-empty').hidden = g.items.length > 0;
    paintGalleryCounts(data);
  } catch (error) {
    el.mosaic.querySelectorAll('.shot-skeleton').forEach((n) => n.remove());
    notice($('#gallery-error'), error.message || 'L’album n’a pas pu se charger.');
  } finally {
    g.loading = false;
  }
}

function showSkeletons(n) {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'shot-skeleton';
    fragment.appendChild(skeleton);
  }
  el.mosaic.appendChild(fragment);
}

/** Rappelle où vivent les souvenirs, et jusqu'à quand on peut venir les chercher. */
function paintKeepsafe() {
  const node = $('#keepsafe');
  if (!node || !state.gallery.items.length) { if (node) node.hidden = true; return; }

  const until = state.guest?.config?.availableUntil;
  const date = until
    ? new Date(until).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  node.innerHTML = date
    ? `Vos souvenirs restent ici jusqu’au <b>${date}</b>. Vous pouvez revenir les chercher quand vous voulez — touchez une photo, ou appuyez longuement pour en choisir plusieurs.`
    : 'Touchez une photo pour la revoir, ou appuyez longuement pour en choisir plusieurs et les enregistrer.';
  node.hidden = false;
}

function paintGalleryCounts(data) {
  const label = data.total
    ? `${data.total} souvenir${data.total > 1 ? 's' : ''} · ${data.photos} photo${
        data.photos > 1 ? 's' : ''
      }${data.videos ? ` · ${data.videos} vidéo${data.videos > 1 ? 's' : ''}` : ''}`
    : 'L’album se remplira au fil de la journée';
  $('#gallery-sub').textContent = label;
  for (const id of ['#tab-count', '#tab-count-2']) {
    const node = $(id);
    if (node) node.textContent = data.total ? `· ${data.total}` : '';
  }
}

function buildShot(item) {
  const shot = document.createElement('button');
  shot.className = 'shot';
  shot.type = 'button';
  shot.dataset.id = item.id;
  shot.setAttribute('role', 'listitem');

  // La vignette occupe la hauteur qu'appelle son format : une grille de carrés
  // rognerait les portraits et écraserait les panoramas.
  const ratio = item.width && item.height ? item.height / item.width : 1;
  shot.style.gridRowEnd = `span ${Math.round(Math.min(Math.max(ratio, 0.6), 1.7) * 14) + 1}`;
  shot.setAttribute(
    'aria-label',
    `${item.kind === 'video' ? 'Vidéo' : 'Photo'} de ${item.author}${item.mine ? ' — le vôtre' : ''}`
  );

  if (item.hasThumb) {
    const img = document.createElement('img');
    // Le cookie de session part avec la requête : pas besoin d'en-tête ici.
    img.src = `/api/media/${item.id}/thumb`;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    shot.appendChild(img);
  } else {
    shot.classList.add('shot-empty');
    shot.innerHTML = `<svg aria-hidden="true"><use href="#i-${
      item.kind === 'video' ? 'video' : 'gallery'
    }"></use></svg>`;
  }

  if (item.kind === 'video') {
    const kind = document.createElement('span');
    kind.className = 'shot-kind';
    kind.innerHTML = '<svg aria-hidden="true"><use href="#i-play"></use></svg>';
    shot.appendChild(kind);
  }
  if (item.mine) {
    const mine = document.createElement('span');
    mine.className = 'shot-mine';
    mine.textContent = 'Vous';
    shot.appendChild(mine);
  }

  const author = document.createElement('span');
  author.className = 'shot-author';
  author.textContent = item.authorFirst || item.author;
  shot.appendChild(author);

  const pick = document.createElement('span');
  pick.className = 'shot-pick';
  pick.innerHTML = '<svg aria-hidden="true"><use href="#i-check"></use></svg>';
  shot.appendChild(pick);

  shot.addEventListener('click', () => {
    if (state.picking) togglePick(item, shot);
    else openViewer(item);
  });

  // Un appui prolongé ouvre la sélection : le geste attendu d'une galerie photo.
  let holdTimer = null;
  const startHold = () => {
    holdTimer = setTimeout(() => {
      if (!state.picking) {
        setPicking(true);
        togglePick(item, shot);
        navigator.vibrate?.(12);
      }
    }, 420);
  };
  const cancelHold = () => clearTimeout(holdTimer);
  shot.addEventListener('pointerdown', startHold);
  for (const evt of ['pointerup', 'pointerleave', 'pointercancel']) {
    shot.addEventListener(evt, cancelHold);
  }
  shot.addEventListener('contextmenu', (e) => { if (state.picking) e.preventDefault(); });

  return shot;
}

/* ─── Sélection multiple ───────────────────────────────────────── */

function setPicking(on) {
  state.picking = on;
  if (!on) state.picked.clear();
  el.mosaic.classList.toggle('picking', on);
  $('#btn-pick').classList.toggle('is-on', on);
  $('#btn-pick').textContent = on ? 'Terminer' : 'Sélectionner';
  $('#picked-bar').hidden = !on;
  if (!on) {
    for (const node of el.mosaic.querySelectorAll('.shot.is-picked')) {
      node.classList.remove('is-picked');
    }
  }
  paintPicked();
}

function togglePick(item, node) {
  if (state.picked.has(item.id)) state.picked.delete(item.id);
  else state.picked.add(item.id);
  node.classList.toggle('is-picked', state.picked.has(item.id));
  paintPicked();
}

function pickedItems() {
  return state.gallery.items.filter((i) => state.picked.has(i.id));
}

function paintPicked() {
  const chosen = pickedItems();
  const n = chosen.length;
  $('#picked-count').textContent = n
    ? `${n} sélectionné${n > 1 ? 's' : ''} · ${formatBytes(totalBytes(chosen))}`
    : 'Touchez les souvenirs à garder';
  $('#btn-pick-save').disabled = n === 0;
  $('#btn-pick-save-label').textContent = n > 1 ? `Enregistrer les ${n}` : 'Enregistrer';

  // Le retrait n'apparaît que si la sélection ne contient que ses propres souvenirs.
  const onlyMine = n > 0 && chosen.every((i) => i.mine);
  $('#btn-pick-delete').hidden = !onlyMine;
}

$('#btn-pick').addEventListener('click', () => setPicking(!state.picking));
$('#btn-pick-cancel').addEventListener('click', () => setPicking(false));

$('#btn-pick-all').addEventListener('click', () => {
  const all = state.gallery.items;
  const complet = state.picked.size === all.length;
  state.picked = new Set(complet ? [] : all.map((i) => i.id));
  for (const node of el.mosaic.querySelectorAll('.shot')) {
    node.classList.toggle('is-picked', state.picked.has(node.dataset.id));
  }
  paintPicked();
});

$('#btn-pick-save').addEventListener('click', () => saveItems(pickedItems()));

$('#btn-pick-delete').addEventListener('click', () => {
  const chosen = pickedItems().filter((i) => i.mine);
  if (!chosen.length) return;
  confirmDialog({
    title: chosen.length > 1 ? `Retirer ${chosen.length} souvenirs` : 'Retirer ce souvenir',
    text: 'Ils seront définitivement effacés de l’album et du stockage des mariés.',
    confirmLabel: 'Oui, retirer',
    onConfirm: async () => {
      for (const item of chosen) await removeFromGallery(item, { quiet: true });
      setPicking(false);
      paintGalleryCounts({
        total: state.gallery.total,
        photos: state.gallery.items.filter((i) => i.kind === 'photo').length,
        videos: state.gallery.items.filter((i) => i.kind === 'video').length,
      });
    },
  });
});

/* ─── Enregistrer sur son téléphone ────────────────────────────── */

const savingBox = document.createElement('div');
savingBox.className = 'saving';
savingBox.hidden = true;
document.body.appendChild(savingBox);

function saying(message) {
  if (!message) { savingBox.hidden = true; return; }
  savingBox.innerHTML = `<svg class="spin" aria-hidden="true"><use href="#i-loader"></use></svg><span>${message}</span>`;
  savingBox.hidden = false;
}

/**
 * Sur téléphone, la feuille de partage native laisse choisir la destination :
 * Photos, Fichiers, Google Drive… Ailleurs, on télécharge simplement.
 * Les fichiers partent dans leur qualité d'origine.
 */
async function saveItems(items) {
  if (!items.length) return;

  const lots = [];
  for (let i = 0; i < items.length; i += BATCH) lots.push(items.slice(i, i + BATCH));

  try {
    for (let l = 0; l < lots.length; l++) {
      const lot = lots[l];
      const suite = lots.length > 1 ? ` (${l + 1}/${lots.length})` : '';
      const files = await prepareFiles(lot, (done, total) =>
        saying(`Préparation ${done}/${total}${suite}…`)
      );
      saying(null);

      if (canShareFiles()) {
        const done = await shareFiles(files, 'Souvenirs OUISTITII');
        if (!done) files.forEach(downloadFile);
      } else {
        // Les navigateurs limitent les téléchargements en rafale : on espace.
        for (const file of files) {
          downloadFile(file);
          await new Promise((r) => setTimeout(r, 350));
        }
      }
    }
    popSay(items.length > 1 ? 'Souvenirs enregistrés' : 'Souvenir enregistré');
  } catch (error) {
    notice($('#gallery-error'), error.message || 'Enregistrement impossible.');
  } finally {
    saying(null);
  }
}

/** Retrait d'un souvenir de l'album, avec ou sans message. */
async function removeFromGallery(item, { quiet = false } = {}) {
  try {
    await api.removeMedia(item.id);
    const node = el.mosaic.querySelector(`[data-id="${item.id}"]`);
    if (node) await flyOut(node);
    state.gallery.items = state.gallery.items.filter((i) => i.id !== item.id);
    state.picked.delete(item.id);
    state.gallery.total = Math.max(state.gallery.total - 1, 0);
    return true;
  } catch (error) {
    if (!quiet) notice($('#gallery-error'), error.message || 'Retrait impossible.');
    return false;
  }
}

/* ─── Visionneuse ──────────────────────────────────────────────── */

const viewer = $('#viewer');
let viewerItem = null;

function openViewer(item) {
  viewerItem = item;
  const stage = $('#viewer-stage');
  stage.innerHTML = '';

  if (item.kind === 'video') {
    const video = document.createElement('video');
    video.src = `/api/media/${item.id}/file`;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    stage.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.src = `/api/media/${item.id}/file`;
    img.alt = `Souvenir de ${item.author}`;
    stage.appendChild(img);
  }

  $('#viewer-author').textContent = item.mine ? `Votre souvenir — ${item.author}` : `Envoyé par ${item.author}`;
  $('#viewer-remove').hidden = !item.mine;
  $('#viewer-save-label').textContent = canShareFiles() ? 'Enregistrer' : 'Télécharger';

  // Ce qui appartient à quelqu'un d'autre se regarde, ne se retouche pas.
  let locked = viewer.querySelector('.viewer-locked');
  if (!item.mine) {
    if (!locked) {
      locked = document.createElement('span');
      locked.className = 'viewer-locked';
      $('.viewer-bar').appendChild(locked);
    }
    locked.textContent = 'Souvenir verrouillé';
    locked.hidden = false;
  } else if (locked) {
    locked.hidden = true;
  }

  viewer.hidden = false;
  document.body.style.overflow = 'hidden';
  $('#viewer-close').focus();
}

function closeViewer() {
  viewer.hidden = true;
  $('#viewer-stage').innerHTML = '';
  document.body.style.overflow = '';
  viewerItem = null;
}

$('#viewer-close').addEventListener('click', closeViewer);
viewer.addEventListener('click', (event) => { if (event.target === viewer) closeViewer(); });

$('#viewer-save').addEventListener('click', () => {
  if (viewerItem) saveItems([viewerItem]);
});

$('#viewer-remove').addEventListener('click', () => {
  const item = viewerItem;
  if (!item?.mine) return;
  confirmDialog({
    title: 'Retirer ce souvenir',
    text: 'Il sera définitivement effacé de l’album et du stockage des mariés.',
    confirmLabel: 'Oui, retirer',
    onConfirm: async () => {
      // La confirmation s'affiche par-dessus la visionneuse : l'invité n'a
      // pas à en sortir, et elle se referme d'elle-même une fois le geste fait.
      const done = await removeFromGallery(item);
      if (done) {
        closeViewer();
        paintGalleryCounts({
          total: state.gallery.total,
          photos: state.gallery.items.filter((i) => i.kind === 'photo').length,
          videos: state.gallery.items.filter((i) => i.kind === 'video').length,
        });
      }
    },
  });
});

/* ─── Reprise après fermeture ──────────────────────────────────── */

async function restoreQueue() {
  const saved = await store.all();
  const mine = saved.filter((i) => i.contributorSlug === state.guest?.slug && i.state !== 'stored');
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

function closeModal() { modal.hidden = true; modalAction = null; }

$('#modal-cancel').addEventListener('click', closeModal);
$('#modal-confirm').addEventListener('click', () => {
  const action = modalAction;
  closeModal();
  action?.();
});
modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!viewer.hidden) closeViewer();
  else if (!modal.hidden) closeModal();
});

/* ─── Divers ───────────────────────────────────────────────────── */

function setBusy(busy, message) {
  el.btnSend.disabled = busy || state.sending;
  if (message) el.dockStatus.textContent = message;
  document.body.style.cursor = busy ? 'progress' : '';
}

/* ─── Démarrage ────────────────────────────────────────────────── */

(async function boot() {
  plantMascots();
  for (const button of $$('.btn-primary')) magnetize(button, 0.16);

  const saved = api.loadSession();
  if (saved) {
    // On connaît déjà l'invité : son nom est prérempli, il n'a qu'à confirmer.
    firstNameField.value = saved.firstName || '';
    lastNameField.value = saved.lastName || '';
  }

  if (saved && api.hasToken()) {
    state.guest = saved;
    paintIdentity();
    await restoreQueue();
    paintScreen('add');   // session encore valable : on va droit au studio
  } else {
    paintScreen('welcome');
  }
  document.body.dataset.ready = 'true';
})();
