/**
 * export.js — récupérer ses souvenirs sur son téléphone.
 *
 * Pourquoi le partage natif plutôt qu'un bouton « télécharger » ?
 * Parce qu'il ouvre la feuille de partage du téléphone, où l'invité choisit
 * lui-même : « Enregistrer dans Photos », « Enregistrer dans Fichiers »,
 * « Google Drive », « Dropbox »… Un seul mécanisme couvre iOS et Android, et
 * les destinations qu'on n'a pas prévues. Aucun compte à connecter, aucune
 * autorisation à demander, aucune clé d'API à gérer.
 *
 * Les fichiers partent tels qu'ils sont arrivés : c'est l'original stocké qui
 * est servi, jamais une version recompressée.
 */

import { authHeader } from './api.js';

/** Le partage de fichiers existe-t-il vraiment ici ? */
export function canShareFiles() {
  if (!navigator.canShare || !navigator.share) return false;
  try {
    const probe = new File([new Blob(['x'])], 'x.jpg', { type: 'image/jpeg' });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** Récupère l'original et l'emballe en fichier nommé. */
export async function fetchOriginal(item) {
  const response = await fetch(`/api/media/${item.id}/file`, { headers: authHeader() });
  if (!response.ok) throw new Error('Souvenir indisponible');
  const blob = await response.blob();
  return new File([blob], fileNameOf(item), { type: blob.type || 'application/octet-stream' });
}

function fileNameOf(item) {
  const stamp = (item.at || '').slice(0, 19).replace(/[:T]/g, '-') || 'souvenir';
  const who = (item.authorFirst || item.author || 'invite')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  const ext = item.kind === 'video' ? 'mp4' : 'jpg';
  return `ouistitii-${stamp}-${who}.${ext}`;
}

/* ─── Enregistrement ───────────────────────────────────────────── */

/**
 * iOS exige que le partage parte d'un geste de l'invité. On télécharge donc
 * AVANT d'ouvrir la feuille, et le lot est préparé en amont : au moment du
 * clic, il ne reste plus qu'à partager.
 */
export async function shareFiles(files, title) {
  if (!canShareFiles()) return false;
  try {
    await navigator.share({ files, title });
    return true;
  } catch (error) {
    // L'invité a refermé la feuille : ce n'est pas une erreur.
    if (error?.name === 'AbortError') return true;
    return false;
  }
}

/** Repli universel : un téléchargement, comme sur un ordinateur. */
export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/**
 * Le téléphone refuse les lots trop gros. Dix fichiers passent partout ;
 * au-delà, la feuille de partage se ferme sans rien faire sur certains iPhone.
 */
export const BATCH = 10;

/** Prépare un lot en signalant l'avancement — c'est la partie qui prend du temps. */
export async function prepareFiles(items, onProgress) {
  const files = [];
  for (let i = 0; i < items.length; i++) {
    files.push(await fetchOriginal(items[i]));
    onProgress?.(i + 1, items.length);
  }
  return files;
}

/** Poids total d'une sélection, pour prévenir avant un gros téléchargement. */
export function totalBytes(items) {
  return items.reduce((sum, i) => sum + (i.bytes || 0), 0);
}
