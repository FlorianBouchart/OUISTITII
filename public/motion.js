/**
 * motion.js — la vie de l'application.
 *
 * Trois principes, hérités des sites du mariage et du portfolio :
 *   • aucun changement d'écran n'est un saut sec — la queue du ouistiti passe
 *     toujours entre deux écrans ;
 *   • la mascotte réagit à ce que fait l'invité (elle regarde, elle sourit,
 *     elle s'agite quand les photos arrivent) ;
 *   • tout se coupe proprement si le téléphone demande moins d'animations.
 */

const gsap = window.gsap;

export const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const finePointer = () => window.matchMedia('(pointer: fine)').matches;

/* ═══════════════════════════════════════════════════════════════
   TRANSITION — la queue de ouistiti balaie l'écran
   ═══════════════════════════════════════════════════════════════ */

const VEIL_BULGE = 'M0 40 C 90 -34, 285 -34, 375 40 L375 120 L0 120 Z';
const VEIL_FLAT  = 'M0 0  C 90 0,   285 0,   375 0  L375 120 L0 120 Z';

let curtainBusy = false;

/**
 * Rideau de passage. Le voile navy monte du bas avec un bord bombé, la queue
 * s'y dessine en or, puis tout se retire vers le haut.
 * `swap` est appelé quand l'écran est couvert : c'est là qu'on change de vue.
 */
export function curtain(swap, { word } = {}) {
  const veil = document.querySelector('#curtain');
  if (reducedMotion() || !veil || !gsap) {
    swap();
    return Promise.resolve();
  }
  if (curtainBusy) {
    swap();
    return Promise.resolve();
  }
  curtainBusy = true;

  const sheetPath = veil.querySelector('.curtain-edge path');
  const tail = veil.querySelector('.curtain-tail-line');
  const rings = veil.querySelectorAll('.curtain-ring');
  const face = veil.querySelector('.curtain-face');
  const label = veil.querySelector('.curtain-word');

  const length = tail.getTotalLength();
  gsap.set(tail, { strokeDasharray: length, strokeDashoffset: length });
  gsap.set(rings, { opacity: 0, scale: 0.4, transformOrigin: 'center' });
  gsap.set(face, { opacity: 0, y: 14, scale: 0.9 });
  gsap.set(label, { opacity: 0, y: 10 });
  if (label) label.textContent = word || '';
  gsap.set(sheetPath, { attr: { d: VEIL_BULGE } });

  veil.hidden = false;

  return new Promise((resolve) => {
    let settled = false;
    let swapped = false;
    let timeline = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      timeline?.kill();
      gsap.set(veil, { clearProps: 'transform' });
      veil.hidden = true;
      curtainBusy = false;
      resolve();
    };

    const swapOnce = () => {
      if (swapped) return;
      swapped = true;
      swap();
    };

    /*
     * Filet de sécurité. GSAP avance au rythme des images écran : téléphone
     * verrouillé ou onglet passé en arrière-plan, la timeline se fige et le
     * rideau resterait tiré pour de bon. Passé le temps prévu, on tranche.
     */
    const guard = setTimeout(() => {
      swapOnce();
      finish();
    }, 3200);

    timeline = gsap
      .timeline({
        defaults: { ease: 'power3.inOut' },
        onComplete: finish,
      })
      // 1. le voile monte, son bord s'aplatit
      .fromTo(veil, { yPercent: 100 }, { yPercent: 0, duration: 0.52 }, 0)
      .to(sheetPath, { attr: { d: VEIL_FLAT }, duration: 0.52 }, 0)
      // 2. la queue se dessine, la frimousse apparaît
      .to(tail, { strokeDashoffset: 0, duration: 0.5, ease: 'power2.out' }, 0.22)
      .to(rings, { opacity: 0.7, scale: 1, duration: 0.22, stagger: 0.035 }, 0.36)
      .to(face, { opacity: 1, y: 0, scale: 1, duration: 0.42, ease: 'back.out(2)' }, 0.34)
      .to(label, { opacity: 1, y: 0, duration: 0.3 }, 0.44)
      // 3. l'écran change derrière le voile
      .add(swapOnce, 0.56)
      // 4. tout se retire vers le haut
      .to(sheetPath, { attr: { d: VEIL_BULGE }, duration: 0.5 }, 0.86)
      .to(tail, { strokeDashoffset: -length * 0.35, duration: 0.42, ease: 'power2.in' }, 0.82)
      .to(rings, { opacity: 0, scale: 0.5, duration: 0.2, stagger: 0.02 }, 0.82)
      .to(face, { opacity: 0, scale: 0.8, duration: 0.26 }, 0.84)
      .to(label, { opacity: 0, y: -8, duration: 0.24 }, 0.84)
      .to(veil, { yPercent: -100, duration: 0.52 }, 0.9);
  });
}

/* ═══════════════════════════════════════════════════════════════
   ENTRÉES D'ÉCRAN
   ═══════════════════════════════════════════════════════════════ */

/**
 * Règle absolue : une animation d'apparition ne doit JAMAIS pouvoir laisser du
 * contenu invisible. GSAP pose l'état de départ (opacité nulle) tout de suite,
 * puis avance au rythme des images écran — or celles-ci s'arrêtent net quand
 * l'onglet passe en arrière-plan ou que le téléphone se verrouille. Sans ce
 * garde-fou, l'invité retrouverait un écran vide.
 */
function guaranteeVisible(tween, targets, after = 1400) {
  const timer = setTimeout(() => {
    if (tween && tween.progress() >= 1) return;
    tween?.kill();
    gsap.set(targets, { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0, clearProps: 'transform' });
  }, after);
  tween?.eventCallback('onComplete', () => clearTimeout(timer));
  return tween;
}

/** Cascade d'apparition sur les éléments marqués [data-rise] d'un écran. */
export function riseIn(root, { delay = 0 } = {}) {
  if (!gsap) return;
  const items = root.querySelectorAll('[data-rise]');
  if (!items.length) return;

  if (reducedMotion()) {
    gsap.set(items, { clearProps: 'all', opacity: 1, y: 0 });
    return;
  }
  const tween = gsap.fromTo(
    items,
    { opacity: 0, y: 18 },
    {
      opacity: 1,
      y: 0,
      duration: 0.62,
      ease: 'power3.out',
      stagger: 0.055,
      delay,
      clearProps: 'transform',
    }
  );
  guaranteeVisible(tween, items);
}

/** Le mot OUISTITII, lettre après lettre. */
export function spellOut(node, { delay = 0 } = {}) {
  if (!node || !gsap) return;
  const word = node.dataset.word || node.textContent.trim();
  if (!node.dataset.split) {
    node.dataset.split = '1';
    node.setAttribute('aria-label', word);
    node.innerHTML = [...word]
      .map((c) => `<span class="ltr" aria-hidden="true">${c}</span>`)
      .join('');
  }
  const letters = node.querySelectorAll('.ltr');
  if (reducedMotion()) {
    gsap.set(letters, { opacity: 1, y: 0, rotate: 0 });
    return;
  }
  const tween = gsap.fromTo(
    letters,
    { opacity: 0, y: 26, rotate: -8 },
    {
      opacity: 1,
      y: 0,
      rotate: 0,
      duration: 0.7,
      ease: 'back.out(1.7)',
      stagger: 0.045,
      delay,
    }
  );
  guaranteeVisible(tween, letters);
}

/* ═══════════════════════════════════════════════════════════════
   LA MASCOTTE
   ═══════════════════════════════════════════════════════════════ */

/**
 * Le ouistiti n'est pas un décor : il regarde ce qu'on tape, il s'excite quand
 * les photos arrivent, il fait « ouistiti ! » quand tout est parti.
 */
export class Mascot {
  constructor(root) {
    this.root = root;
    this.tail = root?.querySelector('.oui-tail');
    this.eyes = root?.querySelectorAll('.oui-eye');
    this.pupils = root?.querySelectorAll('.oui-pupil');
    this.smile = root?.querySelector('.oui-smile');
    this.idle = null;
    this.blinkTimer = null;
    if (this.root && gsap && !reducedMotion()) this.start();
  }

  start() {
    // Respiration : un balancement très lent, presque imperceptible.
    this.idle = gsap.to(this.root, {
      rotate: 2.2,
      y: -3,
      duration: 2.6,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
      transformOrigin: '50% 80%',
    });
    gsap.to(this.tail, {
      rotate: -5,
      duration: 3.1,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
      transformOrigin: '20% 20%',
    });
    this.scheduleBlink();
  }

  scheduleBlink() {
    clearTimeout(this.blinkTimer);
    this.blinkTimer = setTimeout(() => {
      this.blink();
      this.scheduleBlink();
    }, 2600 + Math.random() * 4200);
  }

  blink() {
    if (!this.eyes?.length || reducedMotion()) return;
    gsap.timeline()
      .to(this.eyes, { scaleY: 0.12, duration: 0.08, transformOrigin: 'center' })
      .to(this.eyes, { scaleY: 1, duration: 0.13, ease: 'power2.out' });
  }

  /** Regard qui suit la saisie : les pupilles glissent doucement. */
  look(ratio) {
    if (!this.pupils?.length || reducedMotion()) return;
    gsap.to(this.pupils, {
      x: (ratio - 0.5) * 3.4,
      y: 1.1,
      duration: 0.45,
      ease: 'power2.out',
    });
  }

  /** Petit sursaut de joie — une photo vient d'être ajoutée. */
  cheer() {
    if (!this.root || reducedMotion()) return;
    gsap.timeline()
      .to(this.root, { scale: 1.1, duration: 0.16, ease: 'power2.out', transformOrigin: '50% 85%' })
      .to(this.root, { scale: 1, duration: 0.6, ease: 'elastic.out(1, 0.42)' });
    gsap.fromTo(
      this.tail,
      { rotate: -12 },
      { rotate: 0, duration: 0.75, ease: 'elastic.out(1, 0.35)', transformOrigin: '20% 20%' }
    );
  }

  /** Le grand sourire du « ouistiti ! ». */
  grin() {
    if (!this.smile || reducedMotion()) return;
    gsap.timeline()
      .to(this.smile, { scaleX: 1.16, scaleY: 1.3, duration: 0.22, transformOrigin: '50% 0%' })
      .to(this.smile, { scaleX: 1, scaleY: 1, duration: 0.9, ease: 'elastic.out(1, 0.4)' });
  }

  destroy() {
    clearTimeout(this.blinkTimer);
    this.idle?.kill();
  }
}

/* ═══════════════════════════════════════════════════════════════
   MICRO-INTERACTIONS
   ═══════════════════════════════════════════════════════════════ */

/** Un flash d'appareil photo : le souvenir vient de partir. */
export function flash(target) {
  if (!target || reducedMotion() || !gsap) return;
  const spark = document.createElement('span');
  spark.className = 'flash';
  target.appendChild(spark);
  gsap
    .timeline({ onComplete: () => spark.remove() })
    .fromTo(spark, { opacity: 0 }, { opacity: 0.92, duration: 0.07 })
    .to(spark, { opacity: 0, duration: 0.42, ease: 'power2.out' });
}

/** Arrivée d'une vignette : elle tombe comme un polaroïd qu'on pose. */
export function dropIn(tiles, { from = 0 } = {}) {
  if (!gsap || !tiles.length) return;
  if (reducedMotion()) {
    gsap.set(tiles, { opacity: 1, scale: 1, rotate: 0, y: 0 });
    return;
  }
  const tween = gsap.fromTo(
    tiles,
    { opacity: 0, scale: 0.72, y: -22, rotate: () => gsap.utils.random(-14, 14) },
    {
      opacity: 1,
      scale: 1,
      y: 0,
      rotate: (i, el) => Number(el.dataset.tilt || 0),
      duration: 0.66,
      ease: 'back.out(1.5)',
      stagger: { each: 0.045, from },
      clearProps: 'willChange',
    }
  );
  guaranteeVisible(tween, tiles);
}

/** Retrait d'une vignette : elle s'envole. */
export function flyOut(tile) {
  return new Promise((resolve) => {
    if (!gsap || reducedMotion()) {
      tile.remove();
      resolve();
      return;
    }
    let settled = false;
    // Même précaution que pour le rideau : si les images écran s'arrêtent,
    // le retrait doit aboutir quand même — sans quoi le bouton reste coincé.
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      tile.remove();
      resolve();
    };
    const guard = setTimeout(finish, 900);
    gsap.to(tile, {
      opacity: 0,
      scale: 0.6,
      y: -30,
      rotate: gsap.utils.random(-24, 24),
      duration: 0.36,
      ease: 'power2.in',
      onComplete: finish,
    });
  });
}

/** Bulle « Ouistiti ! » — la marque, au moment où elle a du sens. */
export function popSay(text, anchor) {
  if (reducedMotion() || !gsap) return;
  const bubble = document.createElement('div');
  bubble.className = 'say';
  bubble.textContent = text;
  (anchor || document.body).appendChild(bubble);
  gsap
    .timeline({ onComplete: () => bubble.remove() })
    .fromTo(
      bubble,
      { opacity: 0, y: 14, scale: 0.7 },
      { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'back.out(2.2)' }
    )
    .to(bubble, { opacity: 0, y: -18, duration: 0.42, ease: 'power2.in' }, '+=1.05');
}

/** Attraction magnétique des boutons — seulement là où il y a une souris. */
export function magnetize(node, strength = 0.22) {
  if (!finePointer() || reducedMotion() || !gsap) return;
  const reset = () => gsap.to(node, { x: 0, y: 0, duration: 0.55, ease: 'elastic.out(1, 0.4)' });
  node.addEventListener('pointermove', (event) => {
    const box = node.getBoundingClientRect();
    gsap.to(node, {
      x: (event.clientX - box.left - box.width / 2) * strength,
      y: (event.clientY - box.top - box.height / 2) * strength,
      duration: 0.4,
      ease: 'power3.out',
    });
  });
  node.addEventListener('pointerleave', reset);
  node.addEventListener('pointercancel', reset);
}

/** Compteur qui grimpe, plutôt qu'un chiffre qui apparaît. */
export function countTo(node, value, { duration = 1.1 } = {}) {
  if (!node) return;
  if (reducedMotion() || !gsap) {
    node.textContent = String(value);
    return;
  }
  const state = { n: 0 };
  const tween = gsap.to(state, {
    n: value,
    duration,
    ease: 'power2.out',
    onUpdate: () => { node.textContent = String(Math.round(state.n)); },
  });
  // Un compteur bloqué à zéro annoncerait le contraire de ce qui vient de se passer.
  const timer = setTimeout(() => {
    if (tween.progress() >= 1) return;
    tween.kill();
    node.textContent = String(value);
  }, duration * 1000 + 500);
  tween.eventCallback('onComplete', () => clearTimeout(timer));
}

/** Trait qui se remplit sous un champ pendant la frappe. */
export function inkUnderline(field, ratio) {
  const line = field.querySelector('.field-ink');
  if (!line) return;
  if (!gsap) { line.style.transform = `scaleX(${ratio})`; return; }
  gsap.to(line, { scaleX: ratio, duration: 0.4, ease: 'power2.out' });
}

/** Le sceau final qui se dessine, trait après trait. */
export function drawSeal(svg) {
  if (!svg || !gsap) return;
  const strokes = svg.querySelectorAll('path, circle');
  if (reducedMotion()) {
    gsap.set(strokes, { opacity: 1, strokeDashoffset: 0 });
    return;
  }
  strokes.forEach((node) => {
    const length = node.getTotalLength?.() || 0;
    if (!length) return;
    gsap.set(node, { strokeDasharray: length, strokeDashoffset: length, opacity: 1 });
  });
  const tween = gsap.to(strokes, {
    strokeDashoffset: 0,
    duration: 0.95,
    ease: 'power2.inOut',
    stagger: 0.12,
  });
  // Le sceau non dessiné serait un rond vide : même précaution qu'ailleurs.
  const timer = setTimeout(() => {
    if (tween.progress() >= 1) return;
    tween.kill();
    gsap.set(strokes, { strokeDashoffset: 0, opacity: 1 });
  }, 1600);
  tween.eventCallback('onComplete', () => clearTimeout(timer));
}
