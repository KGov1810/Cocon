# Cocon

Application web pour piloter, depuis un iPhone, des climatiseurs **Atlantic Takao**
reliés au **Hub Cozytouch**, en remplacement de l'application officielle.
Gratuite, installable depuis Safari, en français, en mode clair et sombre.

> ⚠️ Projet personnel, sans lien avec Groupe Atlantic. Il utilise l'API non officielle
> de l'application Cozytouch, qui peut changer sans préavis.

**État : phase 3.** Le tableau de bord pilote chaque pièce : marche et arrêt, mode,
consigne, ventilation, silence, volets, pleine puissance et économie d'énergie. Il
gère aussi le programme hebdomadaire de chaque unité et le mode Absence de toute la
maison. Les créneaux « Arrêt » du programme et le mode Absence restent à valider sur
les unités (voir [Essai guidé](#essai-guidé-phase-3)).

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
**Partager → Sur l'écran d'accueil** : l'icône braise et glacier apparaît, et l'appli
s'ouvre en plein écran. Il peut vous être demandé de vous reconnecter depuis l'icône,
car l'appli installée peut avoir ses propres réglages.

**L'écran principal** montre une pièce à la fois. Les onglets du haut indiquent la
température et le mode des deux pièces ; touchez-en un, ou glissez de côté, pour
changer de pièce. Tout l'écran prend la couleur de l'état :

| Couleur | État |
| --- | --- |
| Braise (orange-rouge) | Chauffage |
| Glacier (bleu) | Froid |
| Violet | Auto |
| Sarcelle (vert-bleu) | Ventilation ou déshumidification |
| Clair | Arrêt |

- Le grand chiffre est la **consigne**, et la ligne en dessous la température mesurée.
- **Glissez vers le haut ou le bas**, n'importe où au centre, pour régler la
  consigne : un demi-degré tous les 22 px, avec l'écart affiché en direct. Elle part
  dès que vous relâchez. Avec VoiceOver ou un clavier, un curseur classique fait le
  même réglage ; il part 1,2 s après le dernier changement.
- Un **niveau** translucide monte avec la consigne. Sa vague va plus vite quand
  l'unité souffle fort : c'est une estimation tirée des réglages, Atlantic ne
  publiant ni la puissance ni la vitesse réelle.
- **⏻** (en haut) éteint la pièce, ou la rallume dans le dernier mode utilisé, ou par
  défaut en chauffage d'octobre à avril et en froid le reste de l'année.
- **Quatre tuiles** en bas résument et ouvrent les réglages : **Mode**, **Vitesse**
  (auto, silence, basse, moyenne, haute), **Volets** (balayage ou 4 positions fixes)
  et **Options** (pleine puissance, économie d'énergie). Un choix s'applique et
  referme le panneau ; tirer la poignée vers le bas le ferme aussi.

**Sous le chiffre**, une ligne suit la dernière commande : « Envoi à Atlantic… »,
puis « Confirmé par Atlantic en 2,1 s », un message d'attente ou la raison d'un refus.
L'écran se met à jour toutes les 20 s quand l'appli est ouverte, et dès qu'on y
revient.

**Une seule unité extérieure** ne peut pas chauffer une pièce et refroidir l'autre en
même temps. Cocon le signale et demande de confirmer un tel choix d'un second appui.

**Économie d'énergie** : ce réglage, absent de l'appli Cozytouch, limite la puissance
de l'unité pour consommer moins. L'essai l'a confirmé : activé, il rend la chauffe
moins puissante. Il était activé d'origine sur les deux unités. Coupez-le pour chauffer
ou refroidir plus vite, et réactivez-le pour économiser.

**Programme hebdomadaire** (bandeau sous les onglets) :
- **Suivre le programme** : l'unité applique d'elle-même les changements prévus, même
  téléphone éteint. Le bandeau indique le prochain, par exemple
  « Programme : 19° à 22:00 ».
- **Modifier le programme** : choisissez le programme *Chauffage* ou *Froid* et le jour,
  puis ajoutez ou modifiez les changements (heure au quart d'heure, température en
  degrés entiers, ou **Arrêt**). *Appliquer à* recopie le jour sur « Lun–ven »,
  « Sam–dim » ou « Toute la semaine ». Les règles de l'unité s'appliquent : au plus
  8 changements par jour, et au moins 1 h entre deux.
- **Changer la consigne pendant que le programme tourne** la modifie à la main
  jusqu'au prochain changement prévu, puis le programme reprend.

**Absence** (bouton valise en haut, menu **…** → *Absence*, ou le bandeau quand une
absence est prévue) : départ maintenant ou plus tard, et date de retour. Les climatiseurs
s'arrêtent pendant l'absence et reprennent leur mode au retour. Elle s'annule d'un
appui.

**Pour la deuxième personne** : générez-lui une clé depuis le diagnostic, ajoutez-la
au secret `ACCESS_KEYS` (`Kevin:clé1, Prénom:clé2`), puis envoyez-lui l'adresse et
sa clé. Le menu **…** en haut à droite donne accès à l'heure de mise à jour, à
l'actualisation, à l'absence, au diagnostic et à la déconnexion.

## Essai guidé (phase 3)

Deux points reposent sur le catalogue d'Atlantic et doivent être confirmés sur une
unité. Comptez environ 1 h 30 pour l'essai A, à faire de jour, et 30 min pour
l'essai B. Notez l'état de départ : le programme d'origine est 20 °C à 06:00 et
19 °C à 22:00, chaque jour.

**A. Créneau « Arrêt » du programme** (sur la Chambre, unité allumée en chauffage)
1. Bandeau Programme → *Modifier le programme* → *Chauffage*, jour d'aujourd'hui.
2. Ajoutez un **Arrêt** au prochain quart d'heure, dans au moins 20 min. Ajoutez
   ensuite une **température** (par exemple 21°) 1 h plus tard. Enregistrez avec
   *Ce jour*.
3. Retour → activez **Suivre le programme**.
4. À l'heure de l'arrêt, l'unité s'arrête-t-elle vraiment ? Une heure plus tard,
   repart-elle à 21° ?
5. Ouvrez le diagnostic, touchez **Copier le rapport** et transmettez-le : il montre
   comment l'unité a enregistré le créneau.
6. Remettez le programme d'origine (06:00 → 20°, 22:00 → 19°, *Toute la semaine*),
   puis désactivez *Suivre le programme* si vous ne voulez pas l'utiliser.

**B. Absence**
1. Menu **…** → *Absence* → *Départ maintenant*, retour dans 30 min →
   *Programmer l'absence*.
2. Les deux unités s'arrêtent-elles ? Le bandeau « Absence en cours » apparaît-il ?
3. *Modifier* → **Annuler l'absence** : les unités repartent-elles dans leur mode ?

Si une étape ne se passe pas comme prévu, notez ce que vous voyez (appli, unité,
messages) et transmettez le rapport du diagnostic.

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
