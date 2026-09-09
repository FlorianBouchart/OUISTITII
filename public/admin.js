/**
 * admin.js — l'espace des mariés : ce qui est arrivé, de qui, et comment le
 * récupérer. Le bucket reste privé : chaque aperçu et chaque téléchargement
 * passe par le Worker, jeton en main.
 */

const $ = (selector) => document.querySelector(selector);

let token = sessionStorage.getItem('ouistitii.admin') || null;
let offset = 0;
const PAGE = 60;
let modalAction = null;

/* ─── Requêtes ─────────────────────────────────────────────────── */

async function call(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    signOut();
    throw new Error('Session expirée.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || 'Erreur du service.');
  }
  return response;
}

const callJson = (path, options) => call(path, options).then((r) => r.json());

/* ─── Connexion ────────────────────────────────────────────────── */

$('#form-login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#login-error');
  error.hidden = true;
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('#password').value }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Mot de passe incorrect.');
    token = payload.token;
    sessionStorage.setItem('ouistitii.admin', token);
    $('#password').value = '';
    await enterBoard();
  } catch (err) {
    error.querySelector('span').textContent = err.message;
    error.hidden = false;
  }
});

$('#btn-logout').addEventListener('click', signOut);

function signOut() {
  token = null;
  sessionStorage.removeItem('ouistitii.admin');
  $('#screen-board').classList.remove('active');
  $('#screen-login').classList.add('active');
}

async function enterBoard() {
  $('#screen-login').classList.remove('active');
  $('#screen-board').classList.add('active');
  await loadOverview();
  await reloadMedia(true);
}

/* ─── Vue d'ensemble ───────────────────────────────────────────── */

async function loadOverview() {
  const data = await callJson('/api/admin/overview');

  $('#stats').innerHTML = [
    ['Souvenirs', data.totals.total],
    ['Photos', data.totals.photos],
    ['Vidéos', data.totals.videos],
    ['Poids total', data.totals.bytesLabel],
    ['Invités', data.contributors.filter((c) => c.total > 0).length],
  ]
    .map(([label, value]) => `<div class="stat"><b>${escapeHtml(value)}</b><span>${label}</span></div>`)
    .join('');

  $('#table-contributors tbody').innerHTML = data.contributors
    .map(
      (c) => `<tr>
        <td>${escapeHtml(c.display_name)}</td>
        <td>${c.photos || 0}</td>
        <td>${c.videos || 0}</td>
        <td>${formatBytes(c.bytes || 0)}</td>
      </tr>`
    )
    .join('');

  const select = $('#filter-contributor');
  select.innerHTML =
    '<option value="">Tous les invités</option>' +
    data.contributors
      .filter((c) => c.total > 0)
      .map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.display_name)}</option>`)
      .join('');
}

/* ─── Liste des médias ─────────────────────────────────────────── */

for (const id of ['#filter-kind', '#filter-contributor', '#filter-status']) {
  $(id).addEventListener('change', () => reloadMedia(true));
}
$('#btn-more').addEventListener('click', () => reloadMedia(false));

async function reloadMedia(reset) {
  if (reset) {
    offset = 0;
    $('#media-grid').innerHTML = '';
  }
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  const kind = $('#filter-kind').value;
  const contributor = $('#filter-contributor').value;
  const status = $('#filter-status').value;
  if (kind) params.set('kind', kind);
  if (contributor) params.set('contributor', contributor);
  if (status) params.set('status', status);

  const { items } = await callJson(`/api/admin/media?${params}`);
  offset += items.length;

  $('#empty-note').hidden = !(offset === 0 && items.length === 0);
  $('#btn-more').hidden = items.length < PAGE;

  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.appendChild(buildCell(item));
  $('#media-grid').appendChild(fragment);
}

function buildCell(item) {
  const cell = document.createElement('div');
  cell.className = 'cell';

  if (item.has_thumb && item.status === 'stored') {
    // On affiche l'aperçu léger, jamais l'original : avec deux mille photos,
    // charger les fichiers pleins mettrait la page à genoux.
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = `/api/media/${item.id}/thumb`;
    img.addEventListener('error', () => { img.remove(); cell.classList.add('cell-video'); });
    cell.appendChild(img);
  } else {
    cell.classList.add('cell-video');
    cell.innerHTML = '<svg aria-hidden="true"><use href="#i-video"></use></svg>';
  }

  const meta = document.createElement('div');
  meta.className = 'cell-meta';
  meta.innerHTML =
    `<b>${escapeHtml(item.display_name)}</b>` +
    `<span>${formatBytes(item.stored_size || item.size || 0)} · ${
      item.completed_at ? new Date(item.completed_at).toLocaleDateString('fr-FR') : item.status
    }</span>`;
  cell.appendChild(meta);

  const tools = document.createElement('div');
  tools.className = 'cell-tools';

  const download = document.createElement('button');
  download.className = 'cell-tool';
  download.title = 'Télécharger';
  download.innerHTML = '<svg aria-hidden="true"><use href="#i-download"></use></svg>';
  download.addEventListener('click', () => downloadOne(item));

  const remove = document.createElement('button');
  remove.className = 'cell-tool danger';
  remove.title = 'Supprimer';
  remove.innerHTML = '<svg aria-hidden="true"><use href="#i-close"></use></svg>';
  remove.addEventListener('click', () =>
    confirmDialog(
      `Supprimer définitivement ce souvenir de ${item.display_name} ? Le fichier sera effacé du stockage.`,
      async () => {
        await call(`/api/admin/media/${item.id}`, { method: 'DELETE' });
        cell.remove();
        await loadOverview();
      }
    )
  );

  tools.append(download, remove);
  cell.appendChild(tools);
  return cell;
}

async function downloadOne(item) {
  const blob = await call(`/api/admin/media/${item.id}/file`).then((r) => r.blob());
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = item.storage_key.split('/').pop();
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* Le lien CSV a besoin du jeton : on le récupère en mémoire puis on le sert. */
$('#link-csv').addEventListener('click', async (event) => {
  event.preventDefault();
  const blob = await call('/api/admin/export.csv').then((r) => r.blob());
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ouistitii-souvenirs.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

$('#btn-cleanup').addEventListener('click', () =>
  confirmDialog(
    'Effacer les envois restés en plan depuis plus de 24 heures ? Les souvenirs arrivés ne sont pas touchés.',
    async () => {
      const { cleaned } = await callJson('/api/admin/cleanup', { method: 'POST' });
      await loadOverview();
      await reloadMedia(true);
      alert(`${cleaned} envoi(s) abandonné(s) nettoyé(s).`);
    }
  )
);

/* ─── Confirmation ─────────────────────────────────────────────── */

function confirmDialog(text, onConfirm) {
  $('#modal-text').textContent = text;
  modalAction = onConfirm;
  $('#modal').hidden = false;
}
$('#modal-cancel').addEventListener('click', () => { $('#modal').hidden = true; modalAction = null; });
$('#modal-confirm').addEventListener('click', async () => {
  const action = modalAction;
  $('#modal').hidden = true;
  modalAction = null;
  try {
    await action?.();
  } catch (error) {
    alert(error.message);
  }
});

/* ─── Utilitaires ──────────────────────────────────────────────── */

function formatBytes(n) {
  if (!n) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

/* ─── Démarrage ────────────────────────────────────────────────── */

if (token) {
  enterBoard().catch(signOut);
}
