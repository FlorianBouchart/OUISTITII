# OUISTITII par T&F

L'application photo et vidéo du mariage de **Thomy & Florian** — 12 décembre 2026,
Domaine les Hauts de Vertigneul.

Un invité ouvre un lien, donne son prénom et son nom, prend ou choisit ses photos,
vérifie, envoie. Rien d'autre. Les fichiers atterrissent dans un stockage privé qui
appartient aux mariés.

```
Bienvenue → Qui nous écrit ? → Ajouter · vérifier · retirer → Envoyer → C'est arrivé
                                        ↕
                                    L'album de tout le monde
```

---

## 1. Ce qui est construit

**Côté invité** (`public/`) — une seule page, sans framework, ~40 Ko de JavaScript.

| | |
|---|---|
| Identification | Prénom + nom. Aucun compte, aucun mot de passe. La session dure 12 h. |
| Ajout | Trois entrées natives : appareil photo, caméra vidéo, galerie (sélection multiple). |
| File d'attente | Miniature, type, durée des vidéos, poids, état, retrait individuel. |
| Anti-doublon | Empreinte locale de chaque fichier, comparée à ce que l'invité a déjà envoyé. |
| Envoi | 3 fichiers en parallèle (2 sur réseau lent), progression par fichier et globale. |
| Fichiers lourds | Découpe en parties de 8 Mo, reprise là où l'envoi s'était arrêté. |
| Coupure réseau | Pause automatique, reprise au retour du réseau, 4 tentatives espacées. |
| Fermeture accidentelle | Fichiers et progression conservés dans IndexedDB, restaurés au retour. |
| Confirmation | Décompte photos / vidéos, et retour immédiat vers « ajouter d'autres souvenirs ». |
| Album partagé | Les souvenirs de tous les invités, filtrables, en aperçus légers. |
| Verrouillage | Un souvenir arrivé n'est plus modifiable — seul son auteur peut le retirer. |

**Côté mariés** (`public/admin.html`) — protégé par mot de passe : totaux, poids,
répartition par invité, aperçu et téléchargement fichier par fichier, suppression,
manifeste CSV (qui a envoyé quoi, quand), nettoyage des envois abandonnés.

**Côté serveur** (`worker/`) — un Worker Cloudflare qui sert l'application *et* son API.

---

## 2. Architecture

```
        Téléphone de l'invité
                │
                │  1. « voici un fichier de 42 Mo, type image/jpeg, empreinte a1b2… »
                ▼
   ┌────────────────────────────┐        ┌──────────────┐
   │   Worker Cloudflare        │───────▶│  D1 (SQLite) │  contributeurs, médias,
   │   API + application        │        └──────────────┘  états, empreintes
   │                            │
   │   vérifie, réserve,        │
   │   signe une URL courte     │
   └────────────┬───────────────┘
                │  2. URL signée (10 min)
                ▼
        Téléphone de l'invité
                │
                │  3. le fichier part DIRECTEMENT, sans passer par le Worker
                ▼
        ┌────────────────┐
        │  R2 (privé)    │   mariage/2026-12-12/photos/<invité>/<horodatage>__<id>__<nom>.jpg
        └────────────────┘
                │
                │  4. « c'est écrit » → le Worker vérifie la taille réelle, puis valide
                ▼
```

Le média ne traverse jamais le serveur : c'est ce qui permet d'encaisser des vidéos
de plusieurs centaines de mégaoctets sans coût de calcul ni limite de traitement.

**Fichiers**

```
worker/
  index.js      routeur, en-têtes de sécurité, CSP
  media.js      session, anti-doublon, réservation, clôture, relais
  admin.js      espace des mariés
  storage.js    façade : envoi direct (signé) ou relais (développement)
  s3.js         signature AWS SigV4 écrite à la main (aucune dépendance)
  auth.js       jetons HMAC-SHA256
  util.js       validation, empreintes de type, garde-fous anti-abus
public/
  index.html    les cinq écrans
  motion.js     rideau de passage, mascotte vivante, micro-interactions
  vendor/       GSAP, servi en local (la CSP interdit les scripts externes)
  app.js        parcours, file d'attente, album, rendu
  uploader.js   moteur d'envoi (parties, reprise, tentatives)
  media-tools.js empreintes, miniatures, cadence
  store.js      persistance IndexedDB
  api.js        client de l'API
  admin.html/js/css   espace des mariés
  app.css       la direction artistique
  assets/       polices sous-ensemblées, logos, toile de Jouy, mascotte
scripts/
  verify-signature.mjs   éprouve la signature SigV4 (`npm run verify`)
schema.sql      base D1
```

**Pourquoi pas de framework ?** Les sites du mariage sont en HTML/CSS/JS. L'application
en hérite : même vocabulaire, même méthode, et un poids qui compte quand un invité
ouvre le lien sur un réseau saturé par deux cents personnes dans la même salle.

---

## 2 bis. L'identité OUISTITII

« Ouistiti », c'est le mot qu'on dit pour sourire sur les photos. La marque part
de là et l'application le rappelle dès la première phrase.

**La mascotte** (`public/assets/ouistiti.svg`) est un ouistiti à pinceaux dessiné
au trait, dans l'esprit des gravures de la toile de Jouy : touffes d'oreilles,
grands yeux, large sourire, et une queue annelée calculée en spirale. Elle n'est
pas un décor — elle réagit. Elle cligne des yeux au repos, suit du regard ce que
l'invité écrit, sursaute quand des photos arrivent, sourit franchement à l'envoi.

**La queue est le rideau de passage.** À chaque changement d'écran, un voile navy
monte du bas avec un bord bombé, la queue s'y dessine en or, la frimousse
apparaît avec un mot — « Enchantés », « Ouistiti ! », « L'album » — puis tout se
retire vers le haut. Aucun écran ne change d'un coup sec.

**Les autres gestes** : le mot OUISTITII s'écrit lettre par lettre ; un trait d'or
se remplit sous les champs pendant la frappe et la signature se trace en dessous
en Parfumerie Script ; les vignettes tombent en cascade, chacune posée un peu de
travers comme un polaroïd ; un flash d'appareil photo éclate sur chaque souvenir
au moment où il arrive ; les compteurs finaux grimpent ; le sceau se dessine
trait par trait. Sur ordinateur, les boutons principaux sont légèrement
magnétiques.

Le tout est piloté par **GSAP, servi en local** (`public/vendor/`) — la politique
de sécurité de contenu interdit tout script externe.

### Une règle qui gouverne toutes les animations

GSAP avance au rythme des images écran. Or celles-ci s'arrêtent net quand
l'onglet passe en arrière-plan ou que le téléphone se verrouille — cas très
banal dans une soirée. Une animation d'apparition qui commence par masquer son
contenu laisserait alors un écran vide, et un rideau resterait tiré pour de bon.

Chaque animation qui masque, couvre ou bloque porte donc un **garde-fou** : passé
son temps prévu, l'état final est posé d'office. Le rideau se retire, le contenu
s'affiche, le retrait aboutit, les compteurs affichent leur vrai chiffre. Une
animation peut échouer ; l'application, jamais.

---

## 2 ter. Qui peut faire quoi

| | Voir l'album | Envoyer | Modifier un souvenir | Le retirer |
|---|---|---|---|---|
| Un invité identifié | oui, tout l'album | oui | **jamais** | ses souvenirs uniquement |
| Un autre invité | oui | oui | **jamais** | non — refus explicite |
| Sans session | non | non | non | non |
| Les mariés | oui | — | **jamais** | oui, partout |

Un souvenir arrivé est **définitif**. Aucune URL d'écriture n'est plus signée
pour sa clé, le relais le refuse, et son aperçu ne peut être déposé qu'une seule
fois. Renvoyer le même fichier est reconnu comme un doublon, pas comme un
remplacement. La seule action encore possible est la suppression, réservée à
l'auteur — les mariés gardant la main sur leur propre stockage.

L'auteur est reconnu par sa session, ouverte avec son prénom et son nom. C'est un
choix assumé : pas de mot de passe, donc pas de friction le jour J. Quelqu'un qui
saisirait exactement le même prénom et le même nom qu'un autre invité hériterait
de ses droits — accepté ici, entre convives d'un mariage, contre le coût d'une
inscription pour deux cents personnes.

---

## 3. Le stockage : pourquoi Cloudflare R2

Hypothèse retenue : **2 000 médias, ~35 Go**, dont 300 à 500 vidéos (une vidéo de
30 s en 4K pèse déjà 180 Mo). Marge haute : 80 Go.

| | R2 *(retenu)* | Google Cloud Storage | Supabase Storage |
|---|---|---|---|
| Stockage 50 Go | ~0,60 $/mois (10 Go offerts) | ~1,00 $/mois | Plan gratuit limité à 1 Go → **Pro à 25 $/mois** |
| **Récupérer les 35 Go** | **0 $** | ~4 $ à chaque fois | inclus |
| Écritures | 1 M/mois offertes | facturées | incluses |
| Fichiers lourds | envoi fractionné S3 | envoi repranable | TUS au-delà de 6 Mo |
| Mise en place | un compte, deux commandes | projet + IAM + compte de service | rapide |
| Front + API + base | **le même fournisseur** | à assembler | Postgres inclus, front ailleurs |

Ce qui a tranché :

1. **Sortie de données gratuite.** Les mariés vont rapatrier plusieurs dizaines de
   gigaoctets, sans doute plusieurs fois (tri, sauvegarde, montage vidéo). Chez les
   autres, chaque copie complète se paie.
2. **Une seule pièce à administrer.** Le Worker sert l'application, l'API, la base et
   le stockage : un `wrangler deploy`, un domaine, aucun problème d'origine croisée.
3. **Aucun enfermement.** R2 parle le protocole S3 : `rclone`, Cyberduck ou n'importe
   quel outil S3 lit le bucket tel quel. Changer de fournisseur = changer trois
   variables d'environnement, le code de signature est standard.
4. **Le coût réel tourne autour d'un euro par mois**, et retombe à zéro une fois les
   souvenirs archivés — un projet de mariage n'a pas à porter un abonnement.

Supabase aurait apporté un tableau de bord tout prêt, mais son plan gratuit (1 Go)
ne tient pas face à 35 Go, et 25 $/mois pour un événement d'un jour n'est pas
raisonnable. Google Cloud Storage est solide mais facture la sortie et demande un
assemblage nettement plus lourd.

---

## 4. Sécurité

- **Aucun secret dans le navigateur.** Clés R2, secret de signature et mot de passe des
  mariés vivent dans `wrangler secret`, jamais dans le code livré.
- **Bucket privé**, sans accès public : chaque lecture passe par le Worker authentifié.
- **URL signées à durée courte** (10 min à 1 h) et **type de contenu signé** : une URL
  obtenue pour une photo ne peut pas servir à déposer autre chose.
- **Contrôle du contenu réel** : les 64 premiers octets du fichier sont vérifiés côté
  serveur avant toute réservation — un exécutable renommé `photo.jpg` est refusé
  *(éprouvé : voir §6)*.
- **La taille annoncée n'est pas crue sur parole** : après écriture, le Worker relit la
  taille réelle dans R2 ; en cas d'écart, le fichier est supprimé et l'envoi rejeté.
- **Jetons HMAC-SHA256** liés au contributeur, valables 12 h, vérifiés à temps constant.
- **Garde-fous anti-abus** : fenêtres glissantes sur l'ouverture de session, la
  réservation de médias et les tentatives de mot de passe.
- **En-têtes** : CSP stricte (aucun script externe), `frame-ancestors 'none'`,
  `nosniff`, HSTS, `Permissions-Policy`.
- **Taille maximale** par fichier : 600 Mo (`MAX_FILE_MB`).
- **Cookie de session** `HttpOnly; Secure; SameSite=Strict`, en plus du jeton :
  les balises `<img>` de l'album ne peuvent pas porter d'en-tête d'autorisation,
  et un jeton en paramètre d'URL fuirait dans les journaux.
- **Écriture verrouillée après arrivée** : voir « Qui peut faire quoi » ci-dessus.

---

## 5. Mise en route

### Développement local

```bash
npm install
cp .dev.vars.example .dev.vars     # renseigner TOKEN_SECRET et ADMIN_PASSWORD
npm run db:migrate                 # crée la base D1 locale
npm run dev                        # http://localhost:5185
```

Sans clés S3, l'application bascule d'elle-même en **mode relais** : les fichiers
passent par le Worker et atterrissent dans le bucket R2 local de Wrangler. Le parcours
complet — découpe en parties comprise — se teste ainsi sans aucun compte.

L'espace des mariés : `http://localhost:5185/admin.html`

### Production

```bash
# 1. Une fois : créer les ressources
npx wrangler login
npm run bucket:create
npm run db:create                  # reporter l'`database_id` dans wrangler.toml
npm run db:migrate:remote

# 2. Les secrets (jamais dans un fichier versionné)
npx wrangler secret put TOKEN_SECRET          # une longue chaîne aléatoire
npx wrangler secret put ADMIN_PASSWORD        # le mot de passe des mariés
npx wrangler secret put S3_ACCESS_KEY_ID      # jeton d'API R2, droits « Object Read & Write »
npx wrangler secret put S3_SECRET_ACCESS_KEY
npx wrangler secret put S3_ENDPOINT           # https://<account_id>.r2.cloudflarestorage.com

# 3. Autoriser le navigateur à écrire dans le bucket
#    (adapter les origines dans r2-cors.json avant)
npm run bucket:cors

# 4. En ligne
npm run deploy
```

Le jeton d'API R2 se crée dans le tableau de bord Cloudflare :
**R2 → Manage R2 API Tokens → Create token → Object Read & Write**, limité au bucket
`ouistitii-medias`.

### Variables et secrets

| Nom | Où | Rôle |
|---|---|---|
| `TOKEN_SECRET` | secret | signature des sessions invité |
| `ADMIN_PASSWORD` | secret | accès à `/admin.html` |
| `S3_ACCESS_KEY_ID` | secret | jeton d'API R2 |
| `S3_SECRET_ACCESS_KEY` | secret | jeton d'API R2 |
| `S3_ENDPOINT` | secret | `https://<account_id>.r2.cloudflarestorage.com` |
| `MAX_FILE_MB` | `wrangler.toml` | taille maximale par fichier (600) |
| `PART_SIZE_MB` | `wrangler.toml` | taille d'une partie (8) |
| `EVENT_DATE` / `EVENT_PREFIX` | `wrangler.toml` | racine des chemins de stockage |

**Sans les trois secrets S3**, l'application fonctionne quand même : elle relaie les
fichiers par le Worker. Utile pour un galop d'essai, à éviter le jour J — les vidéos
lourdes y perdent en confort.

### Récupérer les souvenirs après le mariage

```bash
# Le manifeste (qui a envoyé quoi) : bouton « Manifeste CSV » dans /admin.html
# Tout le bucket, en une commande :
rclone sync r2:ouistitii-medias ./souvenirs-mariage --progress
```

L'arborescence est déjà triée : `mariage/2026-12-12/photos/<invité>/…` et
`…/videos/<invité>/…`.

---

## 6. Ce qui a été éprouvé

Testé de bout en bout sur le Worker local, en émulation iPhone :

- envoi d'une photo seule, puis de sept d'un coup ;
- envoi d'une vidéo ;
- fichier de 13 Mo → découpé en deux parties, recomposé, taille vérifiée ;
- **doublons** : les mêmes fichiers reproposés sont reconnus et écartés ;
- **fichier piégé** : un exécutable renommé `.jpg` est refusé sur ses octets d'en-tête ;
- **coupure réseau en plein envoi** : serveur arrêté → rien de perdu, message clair,
  file intacte ; serveur relancé → tout repart et arrive ;
- **fermeture de l'application** : rechargement → les souvenirs en attente sont restaurés
  avec leurs miniatures ;
- retrait individuel, retrait global, changement d'identité ;
- espace des mariés : totaux, tableau par invité, aperçus, suppression, CSV ;
- **album partagé** : les souvenirs de tous s'affichent en aperçus légers, filtres
  compris, et le compteur suit ;
- **permissions** : un invité voit tout l'album mais reçoit un refus explicite
  (403) s'il tente de retirer le souvenir d'un autre ; sans session, tout est
  fermé (401) ;
- **immuabilité** : réécriture par le relais refusée (409), aperçu non
  remplaçable (409), même fichier renvoyé reconnu comme doublon, tentative sur le
  média d'autrui rejetée (404) ;
- **retrait par l'auteur** : confirmation, effacement du fichier et de son aperçu,
  album mis à jour ;
- **animations sans images écran** : rideau, apparitions, retraits et compteurs
  aboutissent quand même — vérifié dans un navigateur où `requestAnimationFrame`
  ne tourne pas du tout ;
- accessibilité : contrastes tous ≥ 4,5:1, cibles tactiles ≥ 44 px ;
- `npm run verify` : signature SigV4 conforme au vecteur de test officiel d'AWS et à une
  seconde implémentation indépendante (clés accentuées et `uploadId` exotiques compris).

---

## 7. Direction artistique

Reprise des sites du mariage, sans réinvention : crème `#FAF5EF`, navy `#1F2F44`,
or `#C9A86C`, toile de Jouy en filigrane, TAN Angleton pour les titres, Versailles pour
les sous-titres en capitales, Parfumerie Script réservée aux noms des mariés, DM Sans
pour le texte. Cartouche à double filet et losange or, comme sur les invitations.

Une seule liberté prise : l'or de la charte tombe à 2,7:1 sur le crème, insuffisant pour
du texte lu dehors ou dans une salle sombre. Un or plus profond (`--gold-text: #8A6A21`,
4,7:1) sert aux libellés ; l'or d'origine reste aux filets et aux ornements.

Polices sous-ensemblées et converties en WOFF2 : 384 Ko d'habillage complet, toile de
Jouy comprise. La mascotte est un SVG au trait de 5 Ko, inline pour être animable.

Le registre, lui, a été assoupli à la demande : moins de hiérarchie, plus de jeu.
Des onglets à curseur glissant, des filtres en pastilles, des vignettes posées de
travers, une mascotte qui réagit — l'application se comporte comme une
application photo, sans quitter la papeterie du mariage.
