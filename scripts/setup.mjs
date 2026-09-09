/**
 * setup.mjs — enregistrer les cinq secrets, d'une traite.
 *
 * Plutôt que cinq commandes à lancer l'une après l'autre en se demandant à
 * chaque fois ce qu'il faut y mettre, celle-ci explique, demande, et enregistre.
 *
 *   npm run setup
 *
 * Rien n'est écrit sur le disque : les valeurs vont directement chez Cloudflare,
 * qui les chiffre. Elles ne transitent pas non plus par la ligne de commande.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';

const WRANGLER = './node_modules/.bin/wrangler';

/* ─── Saisie ───────────────────────────────────────────────────── */

function demander(question, masquer = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (masquer) {
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (c) => (c.includes(question) ? write(c) : rl.output.write('•'));
    }
    rl.question(question, (r) => {
      if (masquer) rl.output.write('\n');
      rl.close();
      resolve(r.trim());
    });
  });
}

/**
 * Envoie la valeur à wrangler par son entrée standard : elle n'apparaît ni dans
 * la ligne de commande, ni dans l'historique du terminal.
 *
 * Au tout premier secret, wrangler demande s'il faut créer le Worker. Si l'on
 * poussait la valeur sans attendre, elle serait avalée comme réponse à cette
 * question — et enregistrée de travers. On lit donc sa sortie et on répond
 * d'abord « oui », la valeur ne partant qu'ensuite.
 */
function poser(nom, valeur) {
  return new Promise((resolve, reject) => {
    const p = spawn(WRANGLER, ['secret', 'put', nom], { stdio: ['pipe', 'pipe', 'inherit'] });

    let sortie = '';
    let valeurEnvoyee = false;

    const envoyerValeur = () => {
      if (valeurEnvoyee) return;
      valeurEnvoyee = true;
      p.stdin.write(valeur + '\n');
      p.stdin.end();
    };

    p.stdout.on('data', (bloc) => {
      sortie += bloc;
      // « Do you want to create a new Worker… » → oui, il faut le créer.
      if (/create a new worker/i.test(sortie) && !/enter a secret value/i.test(sortie)) {
        p.stdin.write('y\n');
        sortie = '';
        return;
      }
      if (/enter a secret value|valeur du secret/i.test(sortie)) envoyerValeur();
    });

    // Si wrangler n'annonce rien (cas du Worker déjà créé), on n'attend pas.
    const filet = setTimeout(envoyerValeur, 2500);

    p.on('close', (code) => {
      clearTimeout(filet);
      code === 0 ? resolve(sortie) : reject(new Error(`${nom} : échec`));
    });
    p.on('error', reject);
  });
}

/* ─── Déroulé ──────────────────────────────────────────────────── */

console.log(`
═══════════════════════════════════════════════════════════
  OUISTITII — enregistrement des secrets
═══════════════════════════════════════════════════════════

  Cinq valeurs à enregistrer. Une seule est à retenir : le mot
  de passe de votre espace privé. Les autres, l'application s'en
  souvient pour vous.
`);

// 1. Le secret de signature : aucune raison de le choisir soi-même.
const tokenSecret = randomBytes(32).toString('base64url');
console.log('1/5  Clé de signature des sessions');
console.log('     → engendrée au hasard, vous n\'avez rien à retenir.\n');

// 2. Le seul à mémoriser.
console.log('2/5  Mot de passe de votre espace privé');
console.log('     → celui que Thomy et vous taperez sur /admin.html.');
console.log('     → CELUI-LÀ, retenez-le.\n');
console.log('     → laissez vide et appuyez sur Entrée pour en obtenir un.\n');
let adminPassword = await demander('     Mot de passe : ', true);

if (!adminPassword) {
  // Trois mots courants séparés par des tirets : plus solide qu'un mot tordu,
  // et retenable. C'est ce qu'on veut pour un mot de passe qu'on tape à deux.
  const mots = ['ouistiti', 'flocon', 'guirlande', 'velours', 'hiver', 'cannelle',
                'alliance', 'bougie', 'sapin', 'valse', 'givre', 'tendresse',
                'orchestre', 'confetti', 'lanterne', 'clementine'];
  const pioche = () => mots[randomBytes(1)[0] % mots.length];
  adminPassword = `${pioche()}-${pioche()}-${randomBytes(2).toString('hex')}`;
  console.log(`\n     Votre mot de passe : ${adminPassword}`);
  console.log('     Notez-le maintenant : il ne sera plus affiché.\n');
  await demander('     Appuyez sur Entrée quand c\'est fait… ');
} else if (adminPassword.length < 6) {
  console.error('\n     Trop court — six caractères au minimum.\n');
  process.exit(1);
}

console.log('\n3/5  Identifiant client Google  (Google Cloud → Clients)');
const googleId = await demander('     ID client : ');

console.log('\n4/5  Code secret Google  (même écran)');
const googleSecret = await demander('     Code secret : ', true);

console.log('\n5/5  Jeton de renouvellement  (obtenu par « npm run google:token »)');
const googleToken = await demander('     Jeton : ', true);

if (!googleId || !googleSecret || !googleToken) {
  console.error('\n     Il manque une des valeurs Google.\n');
  process.exit(1);
}

console.log('\n─── Enregistrement chez Cloudflare ───\n');

const secrets = [
  ['TOKEN_SECRET', tokenSecret],
  ['ADMIN_PASSWORD', adminPassword],
  ['GOOGLE_CLIENT_ID', googleId],
  ['GOOGLE_CLIENT_SECRET', googleSecret],
  ['GOOGLE_REFRESH_TOKEN', googleToken],
];

for (const [nom, valeur] of secrets) {
  try {
    await poser(nom, valeur);
    console.log(`  ✓ ${nom}`);
  } catch {
    console.error(`  ✗ ${nom} — échec. Êtes-vous connecté ? (npm run login)`);
    process.exit(1);
  }
}

console.log(`
═══════════════════════════════════════════════════════════

  Les cinq secrets sont en place et chiffrés.

  Il ne reste qu'à publier :

      npm run deploy

  Et si un jour vous oubliez le mot de passe de l'espace privé,
  relancez simplement :

      npm run secret:admin
`);
