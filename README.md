# Cocon

Application web pour piloter, depuis un iPhone, des climatiseurs **Atlantic Takao**
reliés au **Hub Cozytouch**, en remplacement de l'application officielle.
Gratuite, installable depuis Safari, en français, en mode clair et sombre.

> ⚠️ Projet personnel, sans lien avec Groupe Atlantic. Il utilise l'API non officielle
> de l'application Cozytouch, qui peut changer sans préavis.

**État : phase 1 (découverte).** Seule la page de diagnostic est en ligne : elle montre
ce que vos unités exposent réellement. Le tableau de bord arrive en phase 2.

- [Analyse de faisabilité](docs/FAISABILITE.md)
- [Architecture](docs/ARCHITECTURE.md)

---

## Installation (une seule fois, environ 15 minutes)

Il faut : ce dépôt GitHub, un compte Cloudflare gratuit et votre compte Cozytouch.
Les intitulés de Cloudflare peuvent varier légèrement.

### 1. Créer le Worker à partir du dépôt

1. Sur [dash.cloudflare.com](https://dash.cloudflare.com), ouvrez **Workers & Pages**.
2. Cliquez sur **Create application**, puis choisissez d'importer un dépôt **GitHub**.
3. Autorisez Cloudflare à accéder à GitHub, puis choisissez le dépôt **cocon**.
4. Le nom du projet doit être **`cocon`** (le même que dans `wrangler.jsonc`), sinon
   le déploiement échoue. Laissez les autres réglages par défaut.
5. Cliquez sur **Save and Deploy**. L'adresse de l'application s'affiche ensuite,
   du type `https://cocon.<votre-sous-domaine>.workers.dev`.

### 2. Saisir les secrets

Dans le Worker **cocon** : **Settings → Variables and Secrets → Add**, type **Secret**.
Ajoutez ces quatre secrets :

| Nom | Valeur |
| --- | --- |
| `COZYTOUCH_EMAIL` | L'e-mail de votre compte Cozytouch |
| `COZYTOUCH_PASSWORD` | Le mot de passe de votre compte Cozytouch |
| `COZYTOUCH_CLIENT_ID` | L'identifiant technique de l'application Atlantic : la valeur entre guillemets de `COZYTOUCH_CLIENT_ID` dans le fichier [`const.py`](https://github.com/gduteil/cozytouch/blob/main/custom_components/cozytouch/const.py) du projet gduteil/cozytouch |
| `ACCESS_KEYS` | Les clés d'accès de chaque personne (voir l'étape 3) |

Ces valeurs restent chiffrées chez Cloudflare. Ne les écrivez jamais dans le dépôt.

### 3. Créer les clés d'accès

1. Ouvrez `https://cocon.<votre-sous-domaine>.workers.dev/diagnostic`.
2. Dépliez **Première installation : créer une clé**, puis touchez **Générer une clé**.
   Faites-le une fois par personne.
3. Remplissez le secret `ACCESS_KEYS` sous la forme `Prénom:clé`, une personne par
   virgule :

   ```
   Kevin:clé-de-kevin, Prénom2:clé-de-la-deuxième-personne
   ```

Une clé contient de 24 à 256 caractères parmi les lettres, les chiffres, `-` et `_`.
Les clés générées par la page respectent ce format ; une clé non conforme est ignorée.
Pour couper l'accès d'une personne, retirez son entrée.

### 4. Lancer le diagnostic

1. Sur la page `/diagnostic`, collez votre clé et touchez **Se connecter**.
2. Vérifiez que **Salon** et **Chambre** apparaissent avec leurs capacités.
3. Touchez **Copier le rapport** et transmettez-le pour préparer la phase 2.
   Les numéros de série et l'adresse y sont masqués.

## Utilisation au quotidien

*(phase 2)* Installation sur l'écran d'accueil de l'iPhone et tableau de bord.

## Mises à jour

Chaque modification publiée sur la branche `main` de GitHub est déployée
automatiquement par Cloudflare. Les secrets ne sont pas touchés.

## Développement (facultatif)

```bash
npm install
cp .dev.vars.example .dev.vars   # puis renseigner des valeurs de test
npm test                         # tests du relais, sans réseau
npm run dev                      # application sur http://localhost:8787
```

## Crédits

Les routes de l'API Magellan sont documentées par le projet open source
[gduteil/cozytouch](https://github.com/gduteil/cozytouch) (intégration Home Assistant).
Cocon n'en reprend aucun code.
