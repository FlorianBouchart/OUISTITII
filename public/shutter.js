/**
 * shutter.js — la transition : un obturateur d'appareil photo.
 *
 * Entre deux écrans, un diaphragme à lames se referme en vrillant, l'écran
 * change dans le noir, puis il se rouvre. C'est le geste d'un appareil photo :
 * il dit exactement ce que fait l'application, et il est net — des arêtes
 * franches, aucune forme molle qui pourrait passer pour un défaut d'affichage.
 *
 * Le rendu tient en une seule opération de remplissage : un rectangle plein
 * écran percé d'un polygone régulier (règle even-odd). Le trou rétrécit et
 * tourne ; quand il atteint zéro, l'écran est couvert. Rien d'autre à composer,
 * donc rien qui puisse ramer.
 */

const BLADES = 7;

export class Shutter {
  constructor(canvas, { quality = 'high' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.quality = quality;
    this.resize();
  }

  resize({ width, height } = {}) {
    const cssW = width || window.innerWidth;
    const cssH = height || window.innerHeight;
    const cap = this.quality === 'low' ? 1 : 2;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);

    this.w = cssW;
    this.h = cssH;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.cx = cssW / 2;
    this.cy = cssH / 2;
    // Le trou doit partir plus grand que l'écran, sinon on verrait ses coins
    // au premier instant. Le rayon d'un polygone régulier est plus court que
    // son apothème : d'où la marge.
    this.maxR = Math.hypot(cssW, cssH) * 0.62;
  }

  /**
   * Ouverture du diaphragme à l'instant `p` (0 → 1) : 1 = grand ouvert.
   * Fermeture vive, court temps mort, réouverture avec un léger dépassement —
   * la mécanique d'un vrai obturateur.
   */
  static aperture(p) {
    if (p < 0.42) return 1 - easeInQuad(p / 0.42);       // il se ferme
    if (p < 0.56) return 0;                              // noir : l'écran change
    const t = (p - 0.56) / 0.44;
    return easeOutBack(t);                               // il se rouvre
  }

  /** Vrille : les lames tournent tout du long, jamais elles ne reviennent. */
  static spin(p) {
    return easeInOutCubic(p) * 0.42;
  }

  draw(p) {
    const ctx = this.ctx;
    const open = Math.max(Shutter.aperture(p), 0);
    const twist = Shutter.spin(p);

    ctx.clearRect(0, 0, this.w, this.h);
    if (open >= 1.001) return;

    const r = this.maxR * open;
    const step = (Math.PI * 2) / BLADES;

    // Le voile, percé du trou de l'obturateur.
    ctx.beginPath();
    ctx.rect(0, 0, this.w, this.h);
    if (r > 0.5) {
      ctx.moveTo(this.cx + r * Math.cos(twist), this.cy + r * Math.sin(twist));
      for (let i = 1; i < BLADES; i++) {
        const a = twist + i * step;
        ctx.lineTo(this.cx + r * Math.cos(a), this.cy + r * Math.sin(a));
      }
      ctx.closePath();
    }
    ctx.fillStyle = '#1F2F44';
    ctx.fill('evenodd');

    if (r <= 0.5) return;

    // Le fil doré sur l'arête des lames : c'est lui qui donne le métal.
    ctx.beginPath();
    for (let i = 0; i < BLADES; i++) {
      const a = twist + i * step;
      const x = this.cx + r * Math.cos(a);
      const y = this.cy + r * Math.sin(a);
      const nx = this.cx + r * Math.cos(a + step);
      const ny = this.cy + r * Math.sin(a + step);
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      // la nervure qui file vers l'extérieur, comme la lame qui s'efface
      ctx.moveTo(x, y);
      ctx.lineTo(this.cx + this.maxR * 1.6 * Math.cos(a - 0.22), this.cy + this.maxR * 1.6 * Math.sin(a - 0.22));
    }
    ctx.strokeStyle = 'rgba(201,168,108,.55)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }
}

const easeInQuad = (t) => t * t;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => {
  const c = 1.34;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

/** Un appareil modeste garde l'animation, en moins de pixels. */
export function detectQuality() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;
  return cores <= 4 || memory <= 2 ? 'low' : 'high';
}
