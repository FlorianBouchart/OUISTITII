/**
 * dev-config.mjs — la configuration de développement, engendrée.
 *
 * En production, les souvenirs vont dans le Drive : aucun stockage objet n'est
 * déclaré, et il ne doit surtout pas l'être — en créer un exigerait une carte
 * bancaire. Mais pour éprouver toute la chaîne en local sans compte Google, il
 * faut bien écrire les octets quelque part : Wrangler sait fabriquer un seau
 * local à la volée, à condition qu'un binding le déclare.
 *
 * Ce fichier recopie donc la configuration réelle en y ajoutant ce seul
 * binding. Il est engendré à chaque `npm run dev` : les deux ne peuvent pas
 * diverger, et il n'est pas versionné.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync('wrangler.toml', 'utf8');

const bloc = `
# ─── ENGENDRÉ — ne pas modifier à la main ───────────────────────
# Seau local de développement, ajouté par scripts/dev-config.mjs.
# Il n'existe que sur cette machine : rien n'est créé chez Cloudflare.
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "ouistitii-dev"
preview_bucket_name = "ouistitii-dev"
`;

writeFileSync(
  'wrangler.dev.toml',
  `# Fichier engendré par « npm run dev » — voir scripts/dev-config.mjs\n` +
    source +
    bloc
);
