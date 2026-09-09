/**
 * store.js — la file d'attente survit à la fermeture de l'application.
 *
 * Un invité qui verrouille son téléphone, reçoit un appel ou ferme l'onglet par
 * mégarde ne doit pas perdre sa sélection : fichiers et progression sont écrits
 * dans IndexedDB, et rechargés au retour.
 */

const DB_NAME = 'ouistitii';
const DB_VERSION = 1;
const STORE = 'items';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('addedAt', 'addedAt');
        store.createIndex('contributorSlug', 'contributorSlug');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    // Navigation privée, quota refusé… l'application continue en mémoire vive.
    console.warn('[ouistitii] stockage local indisponible', error);
    return null;
  });
  return dbPromise;
}

async function tx(mode, run) {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result;
    try {
      result = run(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }).catch((error) => {
    console.warn('[ouistitii] écriture locale impossible', error);
    return null;
  });
}

export const put = (item) => tx('readwrite', (store) => store.put(strip(item)));

export const remove = (id) => tx('readwrite', (store) => store.delete(id));

export const clear = () => tx('readwrite', (store) => store.clear());

export async function all() {
  const items = await tx('readonly', (store) => store.getAll());
  return (items || []).sort((a, b) => a.addedAt - b.addedAt);
}

/** Ne retirer que ce qui est arrivé à bon port ; les échecs restent réparables. */
export async function pruneStored() {
  const items = await all();
  await Promise.all(items.filter((i) => i.state === 'stored').map((i) => remove(i.id)));
}

/** Les champs vivants (objectURL, XHR en cours) n'ont pas à être persistés. */
function strip(item) {
  const { previewUrl, xhr, ...rest } = item;
  return rest;
}

/** Espace disque : utile pour prévenir avant que le navigateur ne refuse tout. */
export async function quota() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota: total } = await navigator.storage.estimate();
    return { usage, quota: total, free: (total || 0) - (usage || 0) };
  } catch {
    return null;
  }
}

/** Demande au navigateur de ne pas évincer nos fichiers sous la pression mémoire. */
export async function persist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* sans effet sur le reste */ }
}
