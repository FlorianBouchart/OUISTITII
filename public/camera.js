/**
 * camera.js — le viseur intégré.
 *
 * Pourquoi ne pas se contenter de l'appareil photo du téléphone ?
 * Parce qu'il impose son propre parcours : on déclenche, il montre le cliché,
 * il faut appuyer sur « Utiliser la photo », et l'application reprend la main.
 * Trois gestes pour une photo — insupportable quand on veut en prendre dix
 * pendant une entrée de mariés.
 *
 * Ici, le flux de la caméra s'affiche dans l'application et chaque appui saisit
 * une image à la volée. Aucune confirmation, aucun aller-retour : on peut
 * mitrailler. Le bouton de l'appareil natif reste disponible à côté, pour qui
 * veut la pleine résolution du téléphone.
 */

/** Résolution demandée : le plus haut que le téléphone accepte de donner. */
const IDEAL = { width: { ideal: 3840 }, height: { ideal: 2160 } };

export class Viewfinder {
  constructor({ onShot, onClose, onError }) {
    this.onShot = onShot;
    this.onClose = onClose;
    this.onError = onError;
    this.stream = null;
    this.facing = 'environment';
    this.count = 0;
    this.busy = false;
    this.build();
  }

  /* ─── Interface ────────────────────────────────────────────── */

  build() {
    const root = document.createElement('div');
    root.className = 'finder';
    root.innerHTML = `
      <video class="finder-view" playsinline muted autoplay></video>
      <div class="finder-flash" aria-hidden="true"></div>

      <div class="finder-top">
        <button class="finder-close" type="button" aria-label="Fermer l'appareil photo">
          <svg aria-hidden="true"><use href="#i-close"></use></svg>
        </button>
        <span class="finder-count" aria-live="polite"></span>
        <button class="finder-flip" type="button" aria-label="Changer de caméra">
          <svg aria-hidden="true"><use href="#i-flip"></use></svg>
        </button>
      </div>

      <div class="finder-strip" aria-label="Photos prises"></div>

      <div class="finder-bottom">
        <span class="finder-hint">Appuyez pour photographier — autant de fois que vous voulez</span>
        <button class="finder-shot" type="button" aria-label="Prendre une photo">
          <span class="finder-shot-ring"></span>
        </button>
      </div>`;

    this.root = root;
    this.video = root.querySelector('.finder-view');
    this.flash = root.querySelector('.finder-flash');
    this.strip = root.querySelector('.finder-strip');
    this.counter = root.querySelector('.finder-count');

    root.querySelector('.finder-close').addEventListener('click', () => this.close());
    root.querySelector('.finder-flip').addEventListener('click', () => this.flip());

    const shutter = root.querySelector('.finder-shot');
    // `pointerdown` plutôt que `click` : trois cents millisecondes de moins par
    // photo, et c'est exactement ce qu'on cherche ici.
    shutter.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.shoot();
    });

    document.body.appendChild(root);
  }

  /* ─── Flux ─────────────────────────────────────────────────── */

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.facing }, ...IDEAL },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      document.body.classList.add('is-shooting');
      return true;
    } catch (error) {
      this.destroy();
      this.onError?.(describe(error));
      return false;
    }
  }

  async flip() {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    this.stopStream();
    await this.start();
  }

  /* ─── Prise de vue ─────────────────────────────────────────── */

  /**
   * Saisit l'image courante du flux. La conversion en fichier est lancée sans
   * qu'on l'attende : le viseur reste réactif, et l'on peut déclencher à
   * nouveau dans la foulée.
   */
  shoot() {
    if (this.busy || !this.video.videoWidth) return;
    this.busy = true;
    setTimeout(() => { this.busy = false; }, 120); // garde-fou anti-rebond

    const canvas = document.createElement('canvas');
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    canvas.getContext('2d').drawImage(this.video, 0, 0);

    this.blink();
    navigator.vibrate?.(8);
    this.count += 1;
    this.counter.textContent = `${this.count} photo${this.count > 1 ? 's' : ''}`;

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `OUISTITII_${stamp()}.jpg`, {
          type: 'image/jpeg',
          lastModified: Date.now(),
        });
        this.addToStrip(blob);
        this.onShot?.(file);
      },
      'image/jpeg',
      0.92
    );
  }

  /** Le clignement de l'obturateur : la seule confirmation dont on ait besoin. */
  blink() {
    this.flash.classList.remove('is-on');
    void this.flash.offsetWidth;
    this.flash.classList.add('is-on');
  }

  /** Les dernières prises défilent en bas : on voit ce qu'on vient de saisir. */
  addToStrip(blob) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.alt = '';
    this.strip.prepend(img);
    while (this.strip.children.length > 8) {
      const last = this.strip.lastElementChild;
      URL.revokeObjectURL(last.src);
      last.remove();
    }
  }

  /* ─── Fin ──────────────────────────────────────────────────── */

  stopStream() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  close() {
    const total = this.count;
    this.destroy();
    this.onClose?.(total);
  }

  destroy() {
    this.stopStream();
    for (const img of this.strip?.querySelectorAll('img') || []) URL.revokeObjectURL(img.src);
    document.body.classList.remove('is-shooting');
    this.root?.remove();
  }
}

/* ─── Outils ───────────────────────────────────────────────────── */

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '');

/** Le viseur est-il seulement possible ici ? */
export const cameraAvailable = () =>
  Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;

function describe(error) {
  switch (error?.name) {
    case 'NotAllowedError':
      return 'L’accès à l’appareil photo a été refusé. Autorisez-le dans les réglages du navigateur, ou utilisez « Choisir dans ma galerie ».';
    case 'NotFoundError':
      return 'Aucun appareil photo trouvé sur cet appareil.';
    case 'NotReadableError':
      return 'L’appareil photo est déjà utilisé par une autre application.';
    default:
      return 'L’appareil photo n’a pas pu s’ouvrir. Essayez « Choisir dans ma galerie ».';
  }
}
