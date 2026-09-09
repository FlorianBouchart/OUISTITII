# Mettre OUISTITII en ligne — pas à pas

Deux choses à faire, dans cet ordre :

1. **Autoriser l'application sur votre Google Drive** (~10 min)
2. **Mettre l'application en ligne chez Cloudflare** (~10 min)

Aucune carte bancaire n'est demandée à aucun moment. Si un formulaire vous en
réclame une, c'est que vous n'êtes pas au bon endroit : arrêtez-vous et
relisez l'étape.

---

## Pourquoi pas GitHub Pages

GitHub Pages est une **vitrine** : on y dépose des pages, les visiteurs les
regardent. Il n'y a personne derrière le comptoir.

OUISTITII a besoin de quelqu'un derrière le comptoir. Quand un invité envoie une
photo, il faut que **quelque chose** la reçoive, la range dans votre Drive,
vérifie que c'est bien lui qui a le droit de la retirer ensuite. Ça, c'est un
programme qui tourne en permanence — et GitHub Pages n'en fait tourner aucun.

Avec Pages, l'écran d'accueil s'afficherait, puis tout s'arrêterait à la seconde
où quelqu'un tape son nom.

**Cloudflare Workers** fait les deux à la fois : il sert les pages **et** fait
tourner le programme. Un seul endroit, gratuit jusqu'à 100 000 visites par jour
(un mariage en consommera quelques milliers, tout compris).

👉 **Sur GitHub, allez dans _Settings → Pages_ et cliquez sur « Unpublish site ».**
Cette adresse ne servira à rien.

---

## Étape 1 — Autoriser l'application sur votre Drive

> Connectez-vous d'abord avec **le compte Google dont vous voulez utiliser le
> Drive**. C'est là que les souvenirs atterriront.

### 1.1 Créer un projet

1. Ouvrez **console.cloud.google.com**
2. Tout en haut, à côté de « Google Cloud », cliquez sur le **sélecteur de
   projet** (il affiche un nom de projet ou « Sélectionner un projet »)
3. **Nouveau projet** → Nom : `OUISTITII` → **Créer**
4. Attendez quelques secondes, puis **sélectionnez ce projet** dans le même
   sélecteur

### 1.2 Activer l'accès au Drive

1. Menu **☰** (en haut à gauche) → **API et services** → **Bibliothèque**
2. Dans la recherche, tapez `Google Drive API`
3. Cliquez sur le résultat → bouton **Activer**

### 1.3 Décrire l'application

Selon l'ancienneté de votre interface, cette section s'appelle **« Écran de
consentement OAuth »** ou **« Google Auth Platform »**. C'est la même chose.

1. Menu **☰** → **API et services** → **Écran de consentement OAuth**
2. Type d'utilisateur : **Externe** → **Créer**
3. Remplissez seulement les champs obligatoires :
   - Nom de l'application : `OUISTITII`
   - Adresse e-mail d'assistance : votre adresse
   - Coordonnées du développeur : votre adresse
4. **Enregistrer et continuer**

**Écran « Niveaux d'accès » (scopes)** — c'est l'étape importante :

5. Cliquez **Ajouter ou supprimer des champs d'application**
6. Dans le filtre, tapez `drive.file`
7. Cochez la ligne **`.../auth/drive.file`**
   *(sa description dit : voir et gérer uniquement les fichiers créés par cette
   application — c'est exactement ce qu'on veut : elle ne verra jamais le reste
   de votre Drive)*
8. **Mettre à jour** → **Enregistrer et continuer**

**Écran « Utilisateurs test »** :

9. **Ajouter des utilisateurs** → votre adresse Gmail → **Ajouter**
10. **Enregistrer et continuer**

> L'application reste en mode « test ». C'est voulu : Google ne demande aucune
> vérification, puisque le seul compte concerné est le vôtre.

### 1.4 Créer les identifiants

1. Menu **☰** → **API et services** → **Identifiants**
2. **+ Créer des identifiants** → **ID client OAuth**
3. Type d'application : **Application de bureau**
4. Nom : `OUISTITII` → **Créer**
5. Une fenêtre affiche **l'ID client** et le **code secret du client**.
   Gardez-la ouverte, ou copiez les deux quelque part.

### 1.5 Récupérer le jeton

Dans le terminal, à la racine du projet :

```bash
npm run google:token -- VOTRE_ID_CLIENT VOTRE_SECRET
```

Une page Google s'ouvre :

- Choisissez votre compte
- Un écran rouge dit **« Google n'a pas validé cette application »** — c'est
  normal, elle est en mode test. Cliquez **Paramètres avancés**, puis
  **Accéder à OUISTITII (non sécurisé)**
- **Autoriser**

Le terminal affiche alors une longue suite de caractères commençant par `1//`.
C'est votre **jeton de renouvellement**. Gardez-le sous la main.

---

## Étape 2 — Mettre en ligne chez Cloudflare

Workers et sa base de données sont gratuits, **sans carte bancaire**. (C'est le
stockage de fichiers de Cloudflare qui en demandait une — on ne l'utilise pas.)

### 2.1 Se connecter

```bash
npx wrangler login
```

Une page s'ouvre, vous créez un compte ou vous connectez, vous autorisez.

### 2.2 Créer la base de données

```bash
npm run db:create
```

La commande affiche un bloc contenant une ligne du genre :

```
database_id = "8f3c1a2e-...-..."
```

**Copiez cet identifiant** et collez-le dans le fichier `wrangler.toml`, à la
place de `REMPLACER_PAR_L_ID_D1`.

### 2.3 Enregistrer les secrets

Cinq commandes. Chacune demande la valeur, que vous collez puis validez.

```bash
npx wrangler secret put TOKEN_SECRET
```
→ collez n'importe quelle longue suite de caractères au hasard (30+ signes)

```bash
npx wrangler secret put ADMIN_PASSWORD
```
→ le mot de passe de votre espace privé, celui que Thomy et vous utiliserez

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
```
→ les trois valeurs de l'étape 1

### 2.4 Publier

```bash
npm run deploy
```

À la fin, l'adresse de l'application s'affiche, du type :

```
https://ouistitii.VOTRE-NOM.workers.dev
```

**C'est cette adresse que vous donnerez aux invités** (QR code sur les tables,
lien dans un message de groupe…).

Votre espace privé se trouve à la même adresse suivie de `/admin.html`.

---

## Vérifier que tout marche

1. Ouvrez l'adresse sur votre téléphone
2. Mettez votre prénom et votre nom
3. Envoyez une photo
4. Ouvrez votre Google Drive → un dossier **OUISTITII** doit être apparu, avec
   `Photos / Florian Bouchart / …`

Si la photo arrive : c'est bon, tout fonctionne.

---

## Le verrou anti-dépense

L'application refuse tout nouvel envoi au-delà de **13,5 Go** (réglage
`STORAGE_LIMIT_GB` dans `wrangler.toml`), sous les 15 Go offerts par Google.
Une fois ce seuil atteint :

- personne ne peut plus ajouter de souvenir
- l'album reste consultable
- chacun peut toujours enregistrer les photos sur son téléphone

Aucune facture ne peut donc apparaître. Pour faire de la place, il suffit de
déplacer le dossier `OUISTITII` de votre Drive vers un disque dur, puis de le
vider.
