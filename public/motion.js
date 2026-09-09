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

import { Shutter, detectQuality } from './shutter.js';

const gsap = window.gsap;

export const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const finePointer = () => window.matchMedia('(pointer: fine)').matches;

/* ═══════════════════════════════════════════════════════════════
   TRANSITION — l'obturateur
   ═══════════════════════════════════════════════════════════════ */

let shutter = null;
let curtainBusy = false;
let resizeTimer = null;

function getShutter() {
  if (shutter) return shutter;
  const canvas = document.querySelector('#shutter-canvas');
  if (!canvas || !canvas.getContext) return null;

  shutter = new Shutter(canvas, { quality: detectQuality() });

  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!curtainBusy) shutter.resize(); }, 180);
  };
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });
  return shutter;
}

/**
 * Passage d'un écran à l'autre : le diaphragme se ferme, l'écran change dans le
 * noir, il se rouvre. Court — 720 ms — parce qu'une transition qu'on subit dix
 * fois de suite doit rester une respiration, pas une attente.
 */
export function curtain(swap, { word } = {}) {
  const veil = document.querySelector('#curtain');
  const iris = getShutter();

  if (reducedMotion() || !veil || !gsap || !iris) {
    swap();
    return Promise.resolve();
  }
  if (curtainBusy) {
    swap();
    return Promise.resolve();
  }
  curtainBusy = true;

  const label = veil.querySelector('.curtain-word');
  if (label) label.textContent = word || '';

  const stage = document.querySelector('#app');
  iris.resize();
  veil.hidden = false;

  const state = { p: 0 };
  const duration = 0.72;

  return new Promise((resolve) => {
    let settled = false;
    let swapped = false;
    let timeline = null;

    const render = () => iris.draw(state.p);

    const swapOnce = () => {
      if (swapped) return;
      swapped = true;
      swap();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      gsap.ticker.remove(render);
      timeline?.kill();
      iris.clear();
      veil.hidden = true;
      gsap.set(stage, { clearProps: 'transform,opacity,willChange' });
      gsap.set(label, { clearProps: 'all' });
      curtainBusy = false;
      resolve();
    };

    /*
     * Filet de sécurité. Les images écran s'arrêtent net quand l'onglet passe
     * en arrière-plan ou que le téléphone se verrouille : sans cela, l'invité
     * resterait derrière un obturateur fermé.
     */
    const guard = setTimeout(() => {
      swapOnce();
      finish();
    }, duration * 1000 + 1200);

    gsap.ticker.add(render);
    timeline = gsap.timeline({ onComplete: finish });

    timeline.to(state, { p: 1, duration, ease: 'none' }, 0);

    // La page recule un peu, comme un objectif qui fait le point.
    timeline
      .set(stage, { willChange: 'transform' }, 0)
      .to(stage, { scale: 0.965, opacity: 0.7, duration: duration * 0.42, ease: 'power2.in' }, 0)
      .set(stage, { scale: 1.035, opacity: 0.7 }, duration * 0.52)
      .to(stage, { scale: 1, opacity: 1, duration: duration * 0.46, ease: 'power2.out' }, duration * 0.54);

    if (label) {
      timeline
        .fromTo(label, { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.14 }, duration * 0.42)
        .to(label, { opacity: 0, duration: 0.12 }, duration * 0.58);
    }

    timeline.add(swapOnce, duration * 0.48);
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
    gsap.set(targets, {
      opacity: 1,
      x: 0,
      y: 0,
      scale: 1,
      // On repose l'inclinaison voulue plutôt que de tout remettre droit :
      // sans cela, les vignettes perdraient leur pose de polaroïd.
      rotate: (i, el) => Number(el.dataset.tilt || 0),
    });
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
