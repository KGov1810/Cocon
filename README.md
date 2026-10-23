# Cocon

Application web pour piloter, depuis un iPhone, des climatiseurs **Atlantic Takao**
reliés au **Hub Cozytouch**, en remplacement de l'application officielle.
Gratuite, installable depuis Safari, en français, en mode clair et sombre.

> ⚠️ Projet personnel, sans lien avec Groupe Atlantic. Il utilise l'API non officielle
> de l'application Cozytouch, qui peut changer sans préavis.

**État : phase 2.** Le tableau de bord pilote chaque pièce : marche et arrêt, mode,
consigne, ventilation, silence, volets, pleine puissance et économie d'énergie.
La programmation hebdomadaire et le mode Absence arrivent en phase 3.

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
3. En cas de souci, touchez **Copier le rapport** pour le transmettre. Les numéros
   de série, adresses et adresses MAC y sont masqués.

## Utilisation au quotidien

Ouvrez `https://cocon.<votre-sous-domaine>.workers.dev` dans Safari et connectez-vous
avec votre clé : la session dure 180 jours. Pour l'avoir comme une appli, touchez
**Partager → Sur l'écran d'accueil**. Il peut vous être demandé de vous
reconnecter depuis l'icône, car l'appli installée peut avoir ses propres réglages. Une icône dédiée arrivera en
phase 3.

**L'écran principal** montre une pièce par panneau. La couleur indique l'état :

| Couleur | État |
| --- | --- |
| Braise (orange-rouge) | Chauffage |
| Glacier (bleu) | Froid |
| Violet | Auto |
| Sarcelle (vert-bleu) | Ventilation ou déshumidification |
| Clair | Arrêt |

- Le grand chiffre est la **consigne**, et la ligne en dessous la température mesurée.
- **+ et −** changent la consigne. Elle part 1,2 s après le dernier appui.
- **⏻** éteint la pièce. **Allumer** la rallume dans le dernier mode utilisé, ou par
  défaut en chauffage d'octobre à avril et en froid le reste de l'année.
- **Réglages** ouvre la fiche complète de la pièce : mode, consigne, ventilation,
  silence, volets (balayage ou 4 positions fixes), pleine puissance et économie
  d'énergie.

**Sous chaque pièce**, une ligne suit la dernière commande : « Envoi à Atlantic… »,
puis « Confirmé par Atlantic en 2,1 s », un message d'attente ou la raison d'un refus.
L'écran se met à jour toutes les 20 s quand l'appli est ouverte, et dès qu'on y
revient.

**Une seule unité extérieure** ne peut pas chauffer une pièce et refroidir l'autre en
même temps. Cocon le signale et demande de confirmer un tel choix d'un second appui.

**Économie d'énergie** : ce réglage, absent de l'appli Cozytouch, limite la puissance
de l'unité pour consommer moins. L'essai l'a confirmé : activé, il rend la chauffe
moins puissante. Il était activé d'origine sur les deux unités. Coupez-le pour chauffer
ou refroidir plus vite, et réactivez-le pour économiser.

**Pour la deuxième personne** : générez-lui une clé depuis le diagnostic, ajoutez-la
au secret `ACCESS_KEYS` (`Kevin:clé1, Prénom:clé2`), puis envoyez-lui l'adresse et
sa clé. Le menu **…** en haut à droite donne accès au diagnostic et à la déconnexion.

## Mises à jour

Chaque modification publiée sur la branche `main` de GitHub est déployée
automatiquement par Cloudflare. Les secrets ne sont pas touchés.

## Développement (facultatif)

```bash
npm install
cp .dev.vars.example .dev.vars   # puis renseigner des valeurs de test
npm test                         # tests du relais et de l'affichage, sans réseau
npm run dev                      # application sur http://localhost:8787
```

## Crédits

Les routes de l'API Magellan sont documentées par le projet open source
[gduteil/cozytouch](https://github.com/gduteil/cozytouch) (intégration Home Assistant).
Cocon n'en reprend aucun code.

Police : [Bricolage Grotesque](https://github.com/ateliertriay/bricolage), licence SIL
Open Font License 1.1 (`public/assets/fonts/LICENSE-OFL.txt`).
