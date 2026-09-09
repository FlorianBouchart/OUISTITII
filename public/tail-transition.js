/**
 * tail-transition.js — la queue du ouistiti balaie l'écran.
 *
 * C'est LE moment spectaculaire de l'application : entre deux écrans, une queue
 * de ouistiti traverse la page, s'enroule jusqu'à tout recouvrir, puis se retire
 * en révélant l'écran suivant.
 *
 * Comment elle est faite
 * ──────────────────────
 * La queue n'est pas un dessin qu'on déplace : c'est une chaîne de points reliés
 * par des ressorts amortis. Seule la pointe est pilotée, le reste suit avec du
 * retard. De là viennent gratuitement l'inertie, le fouetté, le dépassement et
 * le retour — la « personnalité » du mouvement.
 *
 * Le rendu se fait sur un seul canvas : un ruban d'épaisseur variable, un reflet
 * pour le volume, des anneaux dorés, et deux échos translucides qui simulent le
 * flou de vitesse sans le moindre filtre (les filtres coûtent une fortune sur
 * téléphone).
 *
 * La profondeur est une vraie projection : chaque point porte un z, projeté
 * autour du centre de l'écran. La queue passe devant, puis s'éloigne.
 *
 * Pourquoi c'est fluide
 * ─────────────────────
 * Rien n'est alloué pendant l'animation (tous les tableaux sont typés et
 * pré-alloués), aucun accès au DOM, aucune ombre portée, aucun filtre. La
 * physique tourne à pas fixe : le rendu est identique quel que soit le nombre
 * d'images par seconde, et une image sautée ne décale rien.
 */

/* ═══════════════════════════════════════════════════════════════
   RÉGLAGES
   ═══════════════════════════════════════════════════════════════ */

const PALETTE = {
  body: '#1F2F44',      // navy de la charte
  bodyDeep: '#101A29',  // la pointe, dans l'ombre
  bodyLit: '#2A3F5B',   // la base, éclairée
  sheen: '#6E8CA8',     // le reflet qui donne le galbe
  ring: '#C9A86C',      // l'or des anneaux
  // Sur fond navy, la queue s'inverse : crème sur navy plutôt que navy sur navy.
  bodyOnDark: '#F2EADF',
  bodyDeepOnDark: '#D8C7B2',
  bodyLitOnDark: '#FFFDF9',
  sheenOnDark: '#FFFFFF',
  ringOnDark: '#8A6A21',
};

/** Mélange deux couleurs hexadécimales. Utilisé une poignée de fois par image. */
function mix(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const ai = parseInt(a.slice(1), 16);
  const bi = parseInt(b.slice(1), 16);
  const r = Math.round((ai >> 16) + (((bi >> 16) - (ai >> 16)) * t));
  const g = Math.round(((ai >> 8) & 255) + ((((bi >> 8) & 255) - ((ai >> 8) & 255)) * t));
  const bl = Math.round((ai & 255) + (((bi & 255) - (ai & 255)) * t));
  return `rgb(${r},${g},${bl})`;
}

/** Une passe de physique dure toujours ce temps-là, quel que soit l'affichage. */
const FIXED_STEP = 1 / 240;
const MAX_CATCH_UP = 8; // au-delà, on laisse filer plutôt que de bloquer l'image

/* ═══════════════════════════════════════════════════════════════
   MOTEUR
   ═══════════════════════════════════════════════════════════════ */

export class TailTransition {
  constructor(canvas, { quality = 'high' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });

    this.quality = quality;
    const segments = quality === 'low' ? 26 : quality === 'mid' ? 34 : 44;
    this.n = segments;

    // Tout est pré-alloué : pas une seule allocation pendant l'animation.
    this.px = new Float32Array(segments);
    this.py = new Float32Array(segments);
    this.pz = new Float32Array(segments);
    this.vx = new Float32Array(segments);
    this.vy = new Float32Array(segments);
    this.taper = new Float32Array(segments);

    // Échos de vitesse : quelques poses précédentes, gardées en anneau.
    this.ghostCount = quality === 'low' ? 0 : quality === 'mid' ? 1 : 2;
    this.ghosts = Array.from({ length: this.ghostCount }, () => ({
      x: new Float32Array(segments),
      y: new Float32Array(segments),
      z: new Float32Array(segments),
      ready: false,
    }));
    this.ghostSlot = 0;
    this.ghostTick = 0;

    // Les bords du ruban, calculés à chaque image puis dessinés d'un trait.
    this.edgeAx = new Float32Array(segments);
    this.edgeAy = new Float32Array(segments);
    this.edgeBx = new Float32Array(segments);
    this.edgeBy = new Float32Array(segments);
    this.width = new Float32Array(segments);

    for (let i = 0; i < segments; i++) {
      // 0 = la pointe (c'est elle qui mène), 1 = la base, épaisse.
      const u = i / (segments - 1);
      this.taper[i] = 0.26 + 0.74 * Math.pow(u, 0.6);
    }

    this.acc = 0;

    this.resize();
  }

  /* ─── Géométrie de l'écran ─────────────────────────────────── */

  /** Les dimensions peuvent être imposées : c'est ce qui rend la scène testable. */
  resize({ width, height } = {}) {
    const cssW = width || window.innerWidth;
    const cssH = height || window.innerHeight;

    // Un pixel de plus n'apporte rien de visible et coûte cher en remplissage.
    const cap = this.quality === 'low' ? 1 : this.quality === 'mid' ? 1.5 : 2;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);

    this.w = cssW;
    this.h = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.diag = Math.hypot(cssW, cssH);
    this.cx = cssW * 0.5;
    this.cy = cssH * 0.5;

    this.buildPath();
  }

  /**
   * La trajectoire est recalculée pour chaque écran : ce n'est pas une courbe
   * dessinée pour un mobile qu'on étirerait sur un ordinateur. En portrait, la
   * queue balaie de bas en haut ; en paysage, elle traverse latéralement.
   */
  buildPath() {
    const { w, h } = this;
    const portrait = h >= w;

    // Points de passage, en fractions du viewport.
    this.route = portrait
      ? [
          [1.06, 1.02],  // elle surgit d'en bas à droite, au ras du cadre
          [0.46, 0.96],
          [-0.16, 0.74], // ressort à gauche : le fouet
          [0.56, 0.54],
          [1.16, 0.34],  // repart à droite
          [0.46, 0.20],
        ]
      : [
          [1.04, 1.03],
          [0.52, 0.88],
          [-0.12, 0.54],
          [0.50, 0.30],
          [1.14, 0.14],
          [0.46, 0.04],
        ];

    this.exit = portrait ? [-0.5, -0.28] : [-0.42, -0.34];

    // Le centre de boucle est légèrement haut : l'œil y va naturellement.
    this.coilX = w * 0.5;
    this.coilY = h * (portrait ? 0.46 : 0.48);
    this.coilR = Math.max(w, h) * (portrait ? 0.42 : 0.36);

    // Le front avance dans le sens général du passage de la queue : du coin
    // d'entrée vers le coin de sortie.
    this.sweepAngle = Math.atan2(
      (this.exit[1] - this.route[0][1]) * h,
      (this.exit[0] - this.route[0][0]) * w
    );

    // Assez longue pour traverser l'écran en entier, jamais assez pour ramer.
    this.length = this.diag * 1.12;
    this.rest = this.length / (this.n - 1);

    // Une queue trop fine ne « balaie » pas : elle passe pour un trait. Sur un
    // téléphone de 390 px, la base fait ici près de 120 px — on la sent passer.
    this.baseWidth = Math.min(Math.max(Math.min(w, h) * 0.3, 72), 260);
    this.focal = this.diag * 1.15;
  }

  /* ─── Trajectoire de la pointe ─────────────────────────────── */

  /**
   * Position de la pointe à l'instant `p` (0 → 1).
   * Trois temps : elle balaie l'écran, elle s'enroule, elle s'échappe.
   */
  tipAt(p, out) {
    const { w, h } = this;

    if (p < 0.44) {
      // Balayage — interpolation douce entre les points de passage.
      const t = p / 0.44;
      // Départ vif : une queue qui s'ébranle lentement laisse l'écran vide au
      // moment où l'invité attend qu'il se passe quelque chose.
      const eased = Math.pow(t, 0.72);
      catmullRom(this.route, eased, out);
      out.x *= w;
      out.y *= h;
      // Elle plonge vers nous au milieu de sa course : c'est là qu'on la sent passer.
      out.z = -0.42 * Math.sin(Math.PI * eased);
      return out;
    }

    if (p < 0.74) {
      // Enroulement — la pointe tourne, le rayon se resserre.
      const t = (p - 0.44) / 0.3;
      // Un tour et demi : la queue tourne pendant que la vague passe derrière.
      const turns = 1.45;
      const last = this.route[this.route.length - 1];
      const start = Math.atan2(last[1] * h - this.coilY, last[0] * w - this.coilX);
      const angle = start + turns * Math.PI * 2 * easeOutCubic(t);
      const radius = this.coilR * (1 - 0.3 * easeInOutCubic(t));
      out.x = this.coilX + Math.cos(angle) * radius;
      out.y = this.coilY + Math.sin(angle) * radius;
      out.z = 0.18 * t;
      return out;
    }

    // Fuite — elle se dévide et file hors champ.
    const t = (p - 0.74) / 0.26;
    const eased = easeInCubic(t);
    const fromX = this.coilX + this.coilR * 0.14;
    const fromY = this.coilY;
    out.x = fromX + (this.exit[0] * w - fromX) * eased;
    out.y = fromY + (this.exit[1] * h - fromY) * eased;
    out.z = -0.3 * Math.sin(Math.PI * t);
    return out;
  }

  /** Gonflement du ruban : discret pendant le balayage, énorme à l'enroulement. */
  swellAt(p) {
    // Elle prend du corps dès son entrée, enfle jusqu'à saturer l'écran pendant
    // l'enroulement, puis se dégonfle en repartant. Le plein n'est tenu qu'un
    // court instant : c'est le balayage qu'on veut regarder, pas l'écran plein.
    if (p < 0.12) return 0.85;
    if (p < 0.44) return 0.85 + 0.75 * easeOutCubic((p - 0.12) / 0.32);
    if (p < 0.72) return 1.6;
    const t = Math.min((p - 0.72) / 0.2, 1);
    return 1.6 - 0.7 * easeInOutCubic(t);
  }

  /**
   * La vague est une bande, pas un rideau : un bord d'attaque qui couvre
   * l'écran, un bord de fuite qui le libère ensuite. Entre les deux, tout est
   * navy — c'est là que l'écran change, à l'abri des regards.
   *
   * Les deux bords avancent dans le même sens, celui du passage de la queue :
   * la page suivante est donc « emportée » par le même geste, sans jamais
   * revenir en arrière.
   */
  frontAt(p) {
    // bord d'attaque : de 0 (hors champ) à 1 (écran entièrement couvert)
    const lead = p < 0.26 ? 0 : p < 0.58 ? easeInOutCubic((p - 0.26) / 0.32) : 1;
    // bord de fuite : il ne s'ébranle qu'une fois l'écran couvert
    const trail = p < 0.66 ? 0 : easeInOutCubic(Math.min((p - 0.66) / 0.32, 1));
    return { lead, trail };
  }

  /**
   * Trace la bande. Le calcul se fait dans un repère aligné sur la direction
   * du balayage : les deux bords deviennent de simples verticales, qu'il suffit
   * d'onduler. Un seul remplissage par image.
   */
  drawFront(ctx, lead, trail) {
    if (lead <= 0 || trail >= 1) return;

    const amp = Math.min(this.w, this.h) * 0.085;
    // Juste ce qu'il faut pour couvrir l'écran en diagonale, ondulation
    // comprise : au-delà, le bord passerait un temps précieux hors du cadre.
    const reach = this.diag * 0.5 + amp + 16;
    const span = this.diag * 0.8;

    // 0 → le bord est hors champ devant ; 1 → il est sorti derrière.
    const leadX = reach - lead * 2 * reach;
    const trailX = reach - trail * 2 * reach;

    ctx.save();
    ctx.translate(this.cx, this.cy);
    ctx.rotate(this.sweepAngle);
    ctx.fillStyle = PALETTE.body;
    ctx.beginPath();

    const steps = 10;
    // bord de fuite, de haut en bas
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = -span + t * 2 * span;
      const x = trailX + Math.sin(t * Math.PI * 2.4 + trail * 3.1) * amp * fade(trail);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    // bord d'attaque, de bas en haut
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      const y = -span + t * 2 * span;
      const x = leadX + Math.sin(t * Math.PI * 2.2 + lead * 2.6) * amp * fade(lead);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ─── Physique ─────────────────────────────────────────────── */

  /** Toute la chaîne se replie sur le point de départ, hors champ. */
  reset() {
    const tip = this.tipAt(0, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < this.n; i++) {
      this.px[i] = tip.x + i * this.rest * 0.26;
      this.py[i] = tip.y + i * this.rest * 0.2;
      this.pz[i] = 0;
      this.vx[i] = 0;
      this.vy[i] = 0;
    }
    for (const ghost of this.ghosts) ghost.ready = false;
    this.ghostTick = 0;
    this.acc = 0;
  }

  /**
   * Un pas de physique, toujours de la même durée. Chaque maillon vise la place
   * que lui laisse le maillon précédent ; le ressort et le frottement font le
   * reste — c'est de là que viennent le retard, le fouet et le rebond.
   */
  integrate(tip) {
    const { px, py, vx, vy, rest, n } = this;
    const stiffness = 260;
    const damping = 0.86;
    const dt = FIXED_STEP;

    px[0] = tip.x;
    py[0] = tip.y;

    for (let i = 1; i < n; i++) {
      const dx = px[i] - px[i - 1];
      const dy = py[i] - py[i - 1];
      const dist = Math.hypot(dx, dy) || 1e-4;

      // Place idéale : dans le prolongement, à la bonne distance.
      const targetX = px[i - 1] + (dx / dist) * rest;
      const targetY = py[i - 1] + (dy / dist) * rest;

      vx[i] = (vx[i] + (targetX - px[i]) * stiffness * dt) * damping;
      vy[i] = (vy[i] + (targetY - py[i]) * stiffness * dt) * damping;

      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
    }
  }

  /** Avance la simulation jusqu'à `p`, par pas fixes : résultat reproductible. */
  advance(p, elapsedMs) {
    const tip = this.tipAt(p, TMP);
    this.acc += Math.min(elapsedMs, 64) / 1000;

    let steps = 0;
    while (this.acc >= FIXED_STEP && steps < MAX_CATCH_UP) {
      this.integrate(tip);
      this.acc -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_CATCH_UP) this.acc = 0; // on ne rattrape pas l'irrattrapable

    // La profondeur file le long de la queue, avec un temps de retard.
    for (let i = 0; i < this.n; i++) {
      const lag = i / (this.n - 1);
      this.pz[i] = tip.z * (1 - lag * 0.55) + lag * 0.12;
    }
  }

  /* ─── Rendu ────────────────────────────────────────────────── */

  /**
   * Projette un point : plus il est loin, plus il se rapproche du centre et
   * rétrécit. C'est ce qui donne le relief, sans la moindre bibliothèque 3D.
   */
  project(x, y, z, out) {
    const scale = this.focal / (this.focal + z * this.diag);
    out.x = this.cx + (x - this.cx) * scale;
    out.y = this.cy + (y - this.cy) * scale;
    out.s = scale;
    return out;
  }

  /** Calcule les deux bords du ruban à partir de la ligne médiane. */
  buildRibbon(px, py, pz, swell) {
    const { n, taper, baseWidth } = this;

    for (let i = 0; i < n; i++) {
      const prev = i === 0 ? i : i - 1;
      const next = i === n - 1 ? i : i + 1;

      let tx = px[next] - px[prev];
      let ty = py[next] - py[prev];
      const len = Math.hypot(tx, ty) || 1e-4;
      tx /= len;
      ty /= len;

      const projected = this.project(px[i], py[i], pz[i], PT);
      const half = (baseWidth * taper[i] * swell * projected.s) / 2;

      this.width[i] = half * 2;
      this.edgeAx[i] = projected.x - ty * half;
      this.edgeAy[i] = projected.y + tx * half;
      this.edgeBx[i] = projected.x + ty * half;
      this.edgeBy[i] = projected.y - tx * half;
    }
  }

  /**
   * Trace le contour du ruban — en courbes, jamais en segments droits.
   * Chaque point de la chaîne devient le point de contrôle d'une quadratique
   * qui passe par le milieu de ses voisins : la silhouette reste continue,
   * sans la moindre arête, pour le prix d'une poignée d'additions.
   */
  traceRibbon(ctx) {
    const { n } = this;
    ctx.beginPath();
    smoothSide(ctx, this.edgeAx, this.edgeAy, n, true);
    smoothSide(ctx, this.edgeBx, this.edgeBy, n, false);
    ctx.closePath();
  }

  draw(p) {
    const ctx = this.ctx;
    const swell = this.swellAt(p);

    ctx.clearRect(0, 0, this.w, this.h);

    // 0. La vague : elle avance dans le sillage de la queue, qui passe devant.
    const front = this.frontAt(p);
    this.drawFront(ctx, front.lead, front.trail);

    /*
     * Quand la vague a tout recouvert, la queue se retrouverait navy sur navy —
     * elle disparaîtrait au moment le plus fort. Elle s'inverse donc : crème
     * sur le fond sombre, anneaux dorés foncés. Le geste reste lisible d'un
     * bout à l'autre du passage, et l'inversion de valeurs fait sa part du
     * spectacle.
     */
    const onDark = Math.min(Math.max(front.lead * (1 - front.trail) * 1.25 - 0.12, 0), 1);

    // 1. Les échos : la même queue, quelques instants plus tôt.
    for (let g = 0; g < this.ghostCount; g++) {
      const ghost = this.ghosts[(this.ghostSlot + g) % this.ghostCount];
      if (!ghost.ready) continue;
      this.buildRibbon(ghost.x, ghost.y, ghost.z, swell);
      ctx.globalAlpha = 0.07 - g * 0.03;
      ctx.fillStyle = mix(PALETTE.body, PALETTE.bodyOnDark, onDark);
      this.traceRibbon(ctx);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 2. La queue, teintée d'un bout à l'autre : la pointe s'enfonce dans
    //    l'ombre, la base reste éclairée. C'est ce dégradé qui lui donne du
    //    volume, sans aucun filtre.
    this.buildRibbon(this.px, this.py, this.pz, swell);
    this.traceRibbon(ctx);
    const last = this.n - 1;
    const shade = ctx.createLinearGradient(
      this.px[0], this.py[0], this.px[last], this.py[last]
    );
    shade.addColorStop(0, mix(PALETTE.bodyDeep, PALETTE.bodyDeepOnDark, onDark));
    shade.addColorStop(0.45, mix(PALETTE.body, PALETTE.bodyOnDark, onDark));
    shade.addColorStop(1, mix(PALETTE.bodyLit, PALETTE.bodyLitOnDark, onDark));
    ctx.fillStyle = shade;
    ctx.fill();

    // 3. Le reflet : un liseré clair sur un seul bord suffit à donner le galbe.
    this.drawSheen(ctx, swell, onDark);

    // 4. Les anneaux, la signature de l'animal.
    this.drawRings(ctx, swell, onDark);

    this.captureGhost();
  }

  /** Un liseré clair au tiers du ruban : l'œil y lit un cylindre, pas un aplat. */
  drawSheen(ctx, swell, onDark = 0) {
    const { n } = this;

    const t = 0.27;
    for (let i = 0; i < n; i++) {
      SHEEN_X[i] = this.edgeAx[i] + (this.edgeBx[i] - this.edgeAx[i]) * t;
      SHEEN_Y[i] = this.edgeAy[i] + (this.edgeBy[i] - this.edgeAy[i]) * t;
    }
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = mix(PALETTE.sheen, PALETTE.sheenOnDark, onDark);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    smoothSide(ctx, SHEEN_X, SHEEN_Y, n, true);
    ctx.lineWidth = Math.max(this.baseWidth * 0.11 * Math.min(swell, 2.4), 2.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawRings(ctx, swell, onDark = 0) {
    const { n } = this;
    const every = this.quality === 'low' ? 6 : 4;

    ctx.strokeStyle = mix(PALETTE.ring, PALETTE.ringOnDark, onDark);
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.78;
    ctx.beginPath();
    for (let i = 3; i < n - 1; i += every) {
      const inset = 0.1;
      ctx.moveTo(
        this.edgeAx[i] + (this.edgeBx[i] - this.edgeAx[i]) * inset,
        this.edgeAy[i] + (this.edgeBy[i] - this.edgeAy[i]) * inset
      );
      ctx.lineTo(
        this.edgeAx[i] + (this.edgeBx[i] - this.edgeAx[i]) * (1 - inset),
        this.edgeAy[i] + (this.edgeBy[i] - this.edgeAy[i]) * (1 - inset)
      );
    }
    ctx.lineWidth = Math.max(2.4, this.baseWidth * 0.055 * Math.min(swell, 2.2));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Mémorise la pose courante, une image sur trois, pour les échos. */
  captureGhost() {
    if (!this.ghostCount) return;
    if (++this.ghostTick % 2) return;

    const ghost = this.ghosts[this.ghostSlot];
    ghost.x.set(this.px);
    ghost.y.set(this.py);
    ghost.z.set(this.pz);
    ghost.ready = true;
    this.ghostSlot = (this.ghostSlot + 1) % this.ghostCount;
  }

  /** Rejoue la simulation depuis le début jusqu'à `p` — sert aux vérifications. */
  renderAt(p, stepMs = 16.67) {
    this.reset();
    const frames = Math.max(1, Math.round((p * 1100) / stepMs));
    for (let f = 1; f <= frames; f++) {
      this.advance((f / frames) * p, stepMs);
    }
    this.draw(p);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }
}

/* ═══════════════════════════════════════════════════════════════
   OUTILS
   ═══════════════════════════════════════════════════════════════ */

const TMP = { x: 0, y: 0, z: 0 };
const PT = { x: 0, y: 0, s: 1 };
const SHEEN_X = new Float32Array(64);
const SHEEN_Y = new Float32Array(64);

/**
 * Trace une polyligne en courbes continues. Chaque sommet sert de point de
 * contrôle, la courbe passe par les milieux : le tracé reste lisse même avec
 * peu de points, ce qui permet de garder la chaîne courte — donc rapide.
 * `forward` parcourt le bord dans un sens ou dans l'autre pour fermer le ruban.
 */
function smoothSide(ctx, xs, ys, n, forward) {
  if (forward) {
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2);
    }
    ctx.lineTo(xs[n - 1], ys[n - 1]);
  } else {
    ctx.lineTo(xs[n - 1], ys[n - 1]);
    for (let i = n - 2; i > 0; i--) {
      ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i - 1]) / 2, (ys[i] + ys[i - 1]) / 2);
    }
    ctx.lineTo(xs[0], ys[0]);
  }
}

/** Courbe passant par tous les points de passage, sans cassure. */
function catmullRom(points, t, out) {
  const last = points.length - 1;
  const scaled = Math.min(Math.max(t, 0), 1) * last;
  const i = Math.min(Math.floor(scaled), last - 1);
  const f = scaled - i;

  const p0 = points[Math.max(i - 1, 0)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(i + 2, last)];

  const f2 = f * f;
  const f3 = f2 * f;

  out.x =
    0.5 *
    (2 * p1[0] +
      (-p0[0] + p2[0]) * f +
      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * f2 +
      (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * f3);
  out.y =
    0.5 *
    (2 * p1[1] +
      (-p0[1] + p2[1]) * f +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * f2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * f3);
  return out;
}

/** L'ondulation d'un bord n'a de sens qu'au milieu de sa course. */
const fade = (k) => Math.sin(Math.min(Math.max(k, 0), 1) * Math.PI);

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t) => t * t * t;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Qualité de rendu déduite de l'appareil. Un téléphone modeste garde
 * l'animation, mais allégée : moins de maillons, pas d'écho, moins de pixels.
 */
export function detectQuality() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;
  if (cores <= 4 || memory <= 2) return 'low';
  if (cores <= 6 || memory <= 4) return 'mid';
  return 'high';
}
