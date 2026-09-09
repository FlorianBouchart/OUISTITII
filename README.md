# OUISTITII par T&F

L'application photo et vidéo du mariage de **Thomy & Florian** — 12 décembre 2026,
Domaine les Hauts de Vertigneul.

**En ligne : https://ouistitii.florian-bouchart.workers.dev**
L'espace des mariés se trouve à la même adresse, suivie de `/admin.html`.

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
| Reprendre ses photos | Feuille de partage native : Photos, Fichiers, **Google Drive**, en qualité d'origine. |
| Sélection multiple | Appui long ou bouton dédié, puis enregistrement ou retrait groupé. |
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
  motion.js     orchestration : rideau, mascotte vivante, micro-interactions
  tail-transition.js  le moteur de la queue — physique, projection, rendu
  vendor/       GSAP, servi en local (la CSP interdit les scripts externes)
  app.js        parcours, file d'attente, album, sélection, rendu
  export.js     enregistrement sur le téléphone (partage natif, téléchargement)
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

**La queue est le rideau de passage** — et c'est le morceau de bravoure de
l'application. Voir la section suivante.

**Les autres gestes restent volontairement discrets** — un seul moment
spectaculaire vaut mieux que vingt effets moyens. Le mot OUISTITII s'écrit lettre par lettre ; un trait d'or
se remplit sous les champs pendant la frappe et la signature se trace en dessous
en Parfumerie Script ; les vignettes tombent en cascade, chacune posée un peu de
travers comme un polaroïd ; un flash d'appareil photo éclate sur chaque souvenir
au moment où il arrive ; les compteurs finaux grimpent ; le sceau se dessine
trait par trait. Sur ordinateur, les boutons principaux sont légèrement
magnétiques.

Le tout est piloté par **GSAP, servi en local** (`public/vendor/`) — la politique
de sécurité de contenu interdit tout script externe.

### La transition : la queue balaie l'écran

Aucun écran ne change d'un coup sec. Entre deux vues, la queue du ouistiti
traverse la page, l'écran bascule pendant qu'elle couvre, puis elle s'échappe.

**Ce n'est pas un dessin qu'on déplace.** La queue est une chaîne de points
reliés par des ressorts amortis (`public/tail-transition.js`). Seule la pointe
est pilotée le long d'une trajectoire ; tout le reste suit avec du retard. De là
viennent, sans être programmés un par un, l'inertie, le fouetté, le dépassement
et le retour — la « personnalité » du mouvement.

**Le déroulé**, en une seconde environ :

| | |
|---|---|
| 0 → 150 ms | la page recule d'un cheveu, puis s'enfonce en perspective — l'anticipation |
| 150 → 500 ms | la queue jaillit du bas, fouette en S, ressort par la gauche, revient |
| 500 ms | une vague navy avance dans son sillage, bord ondulé, et couvre l'écran |
| ~640 ms | l'écran change, à l'abri des regards |
| 500 → 880 ms | **la queue s'inverse** : crème sur navy, anneaux dorés — elle reste le sujet |
| 880 → 1050 ms | la vague sort par l'autre bord, la nouvelle page arrive avec un léger dépassement |

**La trajectoire est calculée, pas dessinée.** Elle est reconstruite à chaque
changement de format : en portrait la queue balaie de bas en haut, en paysage
elle traverse latéralement, et la longueur, l'épaisseur, le rayon de boucle et
l'amplitude de la vague se déduisent du viewport. Ce n'est pas une animation
d'ordinateur qu'on rétrécit sur téléphone.

**Le relief sans bibliothèque 3D.** Chaque point porte une profondeur, projetée
autour du centre de l'écran : la queue plonge vers le spectateur au milieu de sa
course, puis s'éloigne. Un dégradé le long du corps, un liseré clair au tiers de
sa largeur et des anneaux dorés font le galbe. Deux échos translucides suggèrent
la vitesse — sans le moindre filtre, qui coûterait une fortune sur téléphone.

**Ce qu'elle coûte**, mesuré image par image sur six formats (petit et grand
téléphone, portrait et paysage, ordinateur, appareil modeste) :

| | |
|---|---|
| Travail par image | **0,08 à 0,4 ms**, pour un budget de 16,7 ms à 60 images/seconde |
| Écran couvert au moment de la bascule | **100 %** sur tous les formats testés |
| Allocations pendant l'animation | **aucune** — tous les tableaux sont typés et pré-alloués |
| Accès au DOM pendant l'animation | **aucun** |
| Après la transition | couches et `will-change` libérés, aucun abonné laissé au ticker |

Sur un appareil modeste (détecté par le nombre de cœurs et la mémoire), la
transition n'est pas remplacée : elle est allégée — chaîne plus courte, échos
supprimés, moins de pixels, page qui recule sans perspective.

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

## 2 quater. Récupérer ses souvenirs

Un invité revient quand il veut : il redonne son prénom et son nom, et retrouve
l'album. Chaque photo peut repartir **dans sa qualité d'origine** — c'est le
fichier stocké qui est servi, jamais une version recompressée.

**Sur téléphone, on passe par la feuille de partage du système**
(`navigator.share` avec fichiers). C'est elle qui propose « Enregistrer dans
Photos », « Enregistrer dans Fichiers », **« Google Drive »**, Dropbox, et toutes
les destinations installées. Un seul mécanisme couvre iOS et Android, sans
compte à connecter, sans autorisation à demander, sans clé d'API Google à gérer
— et sans que l'application ait à connaître les destinations à l'avance.

Sur ordinateur, ou si le partage de fichiers n'est pas disponible, l'application
retombe sur un téléchargement classique, espacé pour que le navigateur ne bloque
pas la rafale.

Les lots partent **par dix** : au-delà, certains iPhone referment la feuille de
partage sans rien enregistrer. Une sélection de cinquante photos part donc en
cinq fois, avec l'avancement affiché.

Pour tout récupérer d'un coup après le mariage, les mariés disposent de leur
propre chemin (§5) : `rclone` sur le bucket, et le manifeste CSV.

**Durée de conservation : aucune.** R2 garde les fichiers tant que le compte
existe — il n'y a ni expiration, ni quota de temps, ni suppression automatique
nulle part dans le code. Compter environ 0,60 $ par mois pour 35 Go, et rien du
tout une fois les souvenirs archivés ailleurs et le bucket vidé.

`AVAILABLE_UNTIL` (vide par défaut) sert uniquement si les mariés décidaient un
jour de fermer l'album : la date renseignée s'afficherait alors aux invités.
Tant qu'elle est vide, l'application annonce l'inverse — que les souvenirs
restent sans limite de durée.

---

## 3. Le stockage : le Drive des mariés, et zéro euro

**Contrainte posée : aucune dépense.** Pas « peu cher » — zéro. Cela a écarté
les stockages objet, qui offrent tous une tranche gratuite mais réclament une
carte bancaire à l'activation et facturent automatiquement au dépassement.

**La solution retenue : le Google Drive des mariés.** Quinze gigaoctets sont
offerts avec n'importe quel compte Google, sans carte bancaire, sans compte à
créer ailleurs — et les souvenirs atterrissent dans un espace que les mariés
possèdent déjà et savent utiliser.

### Le verrou

Quinze gigaoctets ne sont pas infinis. L'application refuse donc tout nouvel
envoi au-delà de `STORAGE_LIMIT_GB` (réglé à **13,5 Go**, une marge sous les
quinze pour qu'une dernière vidéo ne fasse jamais basculer le compte).

Ce que le verrou fait, et ne fait pas :

| | |
|---|---|
| Ajouter des souvenirs | **bloqué** au-delà du plafond, message explicite, entrées désactivées |
| Consulter l'album | reste ouvert |
| Enregistrer sur son téléphone | reste possible |
| Facturation | **impossible** : rien ne peut être écrit au-delà du gratuit |

Le total additionne les envois terminés *et* ceux en cours : dix téléphones qui
déposent en même temps ne peuvent pas franchir le plafond ensemble.

### Comment les fichiers arrivent chez Google

Le Worker ouvre une « session d'envoi reprenable » avec ses identifiants, puis
les octets montent **par tranches de 8 Mo**. Chaque tranche est placée à son
octet exact : une session interrompue redémarre où elle en était, sans
recommencer le fichier.

Les identifiants Google ne quittent jamais le Worker. Le navigateur ne voit
qu'une adresse de session, valable pour un seul fichier.

Le portée demandée est `drive.file` : **l'application ne voit que les fichiers
qu'elle a elle-même déposés**. Elle ne peut ni lire, ni modifier, ni supprimer
quoi que ce soit d'autre dans le Drive.

### L'arborescence dans le Drive

```
OUISTITII/
  Photos/
    Marie Dupont/       20261212-201455__a1b2c3d4__IMG_4821.jpg
    Jean-Baptiste Le Roy/
  Videos/
    Marie Dupont/
  Apercus/              les vignettes de l'album
```

### Si un jour quinze gigaoctets ne suffisent plus

Le code garde son pilote pour un stockage objet compatible S3 (Cloudflare R2,
Backblaze, Scaleway…) : renseigner `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` et
`S3_ENDPOINT` suffit à basculer, sans toucher au reste. Compter alors environ
0,50 $ par mois pour 35 Go — mais c'est une décision, pas un automatisme.

**Durée de conservation : aucune.** Rien n'expire, aucune suppression n'est
programmée nulle part dans le code.

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
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev
```

Sans clés S3, l'application bascule d'elle-même en **mode relais** : les fichiers
passent par le Worker et atterrissent dans le bucket R2 local de Wrangler. Le parcours
complet — découpe en parties comprise — se teste ainsi sans aucun compte.

L'espace des mariés : `http://localhost:5185/admin.html`

### Production

> **Marche à suivre détaillée, écran par écran : [`docs/MISE-EN-LIGNE.md`](docs/MISE-EN-LIGNE.md).**
> Ce qui suit en est le résumé.

**Étape 1 — autoriser l'application sur le Drive** (à faire une seule fois)

1. Ouvrir [console.cloud.google.com](https://console.cloud.google.com), créer un
   projet (gratuit, aucune carte demandée).
2. *API et services → Bibliothèque* → activer **Google Drive API**.
3. *Écran de consentement OAuth* → type **Externe** → renseigner le nom de
   l'application et un e-mail de contact → ajouter la portée
   `.../auth/drive.file` → s'ajouter comme **utilisateur de test**.
   L'application reste en mode test : aucune vérification Google n'est requise,
   puisque le seul compte concerné est celui des mariés.
4. *Identifiants → Créer → ID client OAuth → Application de bureau*.
   Noter l'identifiant et le secret.
5. Obtenir le jeton de renouvellement :

```bash
npm run google:token
```

Une page Google s'ouvre, on autorise, le jeton s'affiche dans le terminal.

**Étape 2 — mettre en ligne**

```bash
npm run login
npm run db:create

npm run setup
npm run deploy
```

> **`npm run …`, jamais `npx wrangler …`** : le nom du dossier contient une
> esperluette et des espaces, sur lesquels `npx` échoue silencieusement
> (« command not found »).

La base se crée d'elle-même au premier appel : aucune migration à lancer.

> **GitHub Pages ne convient pas.** Pages ne sert que des fichiers figés, or
> l'application a besoin d'un serveur pour réserver un envoi, écrire dans le
> Drive et vérifier les permissions. C'est le Worker Cloudflare qui sert à la
> fois l'application et son API — et son plan gratuit (100 000 requêtes par
> jour) est très au-delà des besoins d'un mariage.

### Variables et secrets

| Nom | Où | Rôle |
|---|---|---|
| `TOKEN_SECRET` | secret | signature des sessions invité |
| `ADMIN_PASSWORD` | secret | accès à `/admin.html` |
| `GOOGLE_CLIENT_ID` | secret | identifiant OAuth du projet Google |
| `GOOGLE_CLIENT_SECRET` | secret | secret associé |
| `GOOGLE_REFRESH_TOKEN` | secret | obtenu par `npm run google:token` |
| `STORAGE_LIMIT_GB` | `wrangler.toml` | **le verrou** — plafond au-delà duquel plus rien n'entre (13,5) |
| `S3_*` | secret | seulement si l'on bascule un jour sur un stockage objet |
| `MAX_FILE_MB` | `wrangler.toml` | taille maximale par fichier (600) |
| `PART_SIZE_MB` | `wrangler.toml` | taille d'une partie (8) |
| `EVENT_DATE` / `EVENT_PREFIX` | `wrangler.toml` | racine des chemins de stockage |

**Sans les trois secrets S3**, l'application fonctionne quand même : elle relaie les
fichiers par le Worker. Utile pour un galop d'essai, à éviter le jour J — les vidéos
lourdes y perdent en confort.

### Récupérer les souvenirs après le mariage

Les souvenirs sont déjà dans le Drive des mariés, rangés par type puis par
invité : il suffit d'ouvrir le dossier `OUISTITII`, ou de le synchroniser sur un
ordinateur avec Google Drive pour ordinateur.

Le bouton « Manifeste CSV » de `/admin.html` donne la table complète — qui a
envoyé quoi, quand, et sous quel nom de fichier.

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
- **la transition, image par image** sur six formats : couverture totale au
  moment de la bascule, coût par image mesuré, aucune fuite après six passages,
  navigation intacte quand le canvas est retiré ;
- **la chaîne de l'API de bout en bout** (`npm run verify:api`) : 32 contrôles,
  aucun échec — y compris sur une base d'ancienne génération, dont les colonnes
  manquantes sont ajoutées automatiquement ;
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
