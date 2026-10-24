# Architecture

```
iPhone (appli web Cocon)  →  Worker Cloudflare « cocon »  →  Cloud Atlantic  →  Hub Cozytouch  →  Salon / Chambre
        clé d'accès            secrets Cozytouch             (Magellan)          (Zigbee)
```

## Composants

| Élément | Rôle | Fichiers |
| --- | --- | --- |
| Application web (PWA) | Interface en français, clair/sombre, installée depuis Safari. Ne connaît que la clé d'accès de la personne. | `public/` |
| Relais (Worker Cloudflare) | Vérifie la clé d'accès, se connecte à Atlantic avec les secrets, appelle l'API, renvoie des erreurs compréhensibles. Sert aussi les fichiers de l'application. | `src/worker.js`, `src/auth.js` |
| Client Atlantic | Seul endroit qui connaît l'API Magellan : connexion, jeton en cache, reconnexion sur 401, gestion du quota (429) et des délais, écriture d'une capacité et suivi de son exécution. | `src/atlantic.js` |
| Modèle des pièces | Traduit la vue brute d'Atlantic en pièces (mode, consignes et bornes, température valide, ventilation, volets, options), et valide chaque commande avant de la traduire en écritures de capacités. | `src/rooms.js` |
| Programme | Lit les programmes chaud et froid, calcule le prochain changement à l'heure du logement, valide un jour de programme et le traduit en écritures. Gère aussi la dérogation jusqu'au prochain changement. | `src/program.js` |
| Absence | Lit l'état sur le hub ; valide une fenêtre ; prépare le PUT du logement. | `src/absence.js` |
| Commandes | Lit l'état (avec un cache de 60 s pour les commandes), exécute les écritures et suit leur confirmation. Gère aussi l'absence. | `src/commands.js`, `src/errors.js` |
| Tableau de bord | Une pièce à la fois, colorée selon son état : consigne réglée au doigt, niveau et vague, onglets, quatre tuiles qui ouvrent les panneaux de réglages, suivi des commandes. | `public/index.html`, `public/assets/app.*`, `public/assets/room-view.js`, `public/assets/logic.js`, `public/assets/ui.js` |
| Programme et absence (interface) | Bandeau de programme, éditeur jour par jour, bandeau et fiche Absence. | `public/assets/program-editor.js`, `public/assets/absence-view.js` |
| Installation sur l'écran d'accueil | Manifeste et icônes. | `public/manifest.webmanifest`, `public/assets/icons/` |
| Diagnostic | Lecture seule de tout ce que le compte expose, données sensibles masquées. | `src/diagnostic.js`, `public/diagnostic.html` |

## Choix techniques

**Application web installable (PWA) plutôt qu'une appli native.**
L'App Store et TestFlight demandent un compte développeur Apple payant, et une appli
installée avec un compte gratuit expire au bout de 7 jours. Une PWA s'installe depuis
Safari (« Sur l'écran d'accueil »), ne coûte rien et se met à jour pour tout le monde
dès qu'une nouvelle version est publiée. Un APK serait inutile : les deux utilisateurs
ont un iPhone.

**HTML, CSS et JavaScript simples, sans framework ni compilation.**
Le code publié est exactement le code du dépôt. Moins de dépendances, moins de mises à
jour forcées, et rien à « construire » avant de publier. La police (Bricolage
Grotesque, licence OFL) est hébergée avec l'application : aucune ressource externe.

**Un relais Cloudflare (offre gratuite).**
Il est indispensable pour trois raisons :

1. Garder le mot de passe Cozytouch hors du code, du dépôt et des téléphones (secrets
   chiffrés chez Cloudflare).
2. Donner une clé personnelle à chaque utilisateur, révocable séparément, alors que
   le compte Cozytouch est partagé.
3. Appeler l'API Atlantic, qu'un navigateur ne peut probablement pas appeler
   directement depuis un autre site (restriction CORS).

L'offre gratuite autorise 100 000 requêtes par jour ; deux personnes en utilisent
quelques centaines. Le même Worker sert l'application et l'API : une seule adresse,
un seul déploiement, aucune configuration CORS.

**Déploiement automatique depuis GitHub.**
Cloudflare est relié au dépôt : chaque mise à jour de la branche `main` est publiée
automatiquement (`npx wrangler deploy`). Les secrets saisis dans Cloudflare ne sont
pas touchés par ces déploiements.

**Programmation horaire stockée dans l'appareil.**
L'API lit et écrit le programme hebdomadaire de chaque unité. Il s'exécute même si
le téléphone ou Cloudflare sont indisponibles : aucun serveur de tâches planifiées
n'est nécessaire.

## Déroulement d'une commande

```
Téléphone                    Relais                               Atlantic
   │ POST /api/rooms/1001        │                                     │
   │ { setting, value } ───────▶ │ lit l'état (cache ≤ 60 s)           │
   │                             │ planCommand : valide, traduit       │
   │                             │ POST executions/writecapability ──▶ │ → n° d'exécution
   │                             │ GET executions/<n> (≈ 9 s max) ───▶ │ 1 attente, 2 en cours, 3 terminé
   │ ◀── 200 confirmé / 202 en attente / 4xx-5xx refus                 │
   │ affiche la valeur demandée jusqu'à ce qu'Atlantic la renvoie (90 s max)
```

- **Une commande à la fois par pièce.** Les choix de la pièce sont désactivés
  pendant l'envoi.
- **Consigne** : glissée au doigt, la valeur suit le geste et part quand le doigt se
  lève (un seul envoi par geste). Au curseur natif (clavier, VoiceOver), elle part
  1,2 s après le dernier réglage.
- **Programme actif** : la commande passe d'abord en dérogation (capacité 157),
  sinon le programme reprendrait la main.
- **Multi-split** : passer en chaud pendant que l'autre pièce refroidit, ou
  l'inverse, demande un second appui de confirmation.
- **État** : relu toutes les 20 s quand l'appli est au premier plan, 1,5 s après une
  confirmation et 8 s après une commande restée en attente. Cela représente environ
  3 lectures par minute et par téléphone, plus 2 à 7 requêtes par commande. Le
  quota Atlantic est de 30 requêtes par minute, partagé avec l'appli officielle.

## Programme hebdomadaire

Chaque unité stocke deux programmes de 7 jours, chaud (capacités 100320 à 100326, du
lundi au dimanche) et froid (100327 à 100333). Un jour est une chaîne de 10 triplets
`[minute, consigne, état]`, les emplacements inutilisés valant `[0,0,0]`. L'état 1
signifie **Arrêt** : c'est ce que dit le catalogue Atlantic (capacité 100013), mais
cela reste à confirmer sur l'unité (voir l'essai guidé du README). Les règles
viennent de l'unité : pas de 15 min (295), au moins 60 min entre deux changements
(296), au plus 8 changements par jour (306) et au moins 1 par semaine (348).

- **Activation** : capacité 184 (0 manuel, 1 programme).
- **Dérogation** : quand on change la consigne pendant un programme actif, le relais
  écrit d'abord la durée jusqu'au prochain changement (158, au plus 24 h), puis
  active la dérogation (157), puis écrit la consigne.
- **Heure du logement** : le prochain changement est calculé avec le décalage
  horaire porté par le hub (315).
- **Écriture de plusieurs jours** : on envoie toutes les écritures, puis on suit la
  dernière jusqu'au bout et on vérifie les autres une seule fois. Pour 7 jours, cela
  fait environ 20 requêtes au lieu d'une cinquantaine. Le quota d'Atlantic est
  d'environ 30 requêtes par minute.

## Mode Absence

L'absence vaut pour tout le logement. Le relais envoie
`PUT /magellan/v2/setups/<id>` avec les champs modifiables du logement (recopiés
depuis Atlantic) et `absence: { startDate, endDate }` en secondes Unix, ou un objet
vide pour l'annuler. Il recopie ensuite la fenêtre sur le hub (capacité 222). Si le
hub refuse cette copie, l'absence reste enregistrée sur le logement : la réponse est
« en attente ». L'état se lit sur le hub : 152 vaut 0 (désactivée), 1 (en cours) ou
2 (programmée).

| Route | Rôle |
| --- | --- |
| `GET /api/state` | Pièces (avec leur programme) et absence |
| `POST /api/rooms/:id` | Réglages : `mode`, `setpoint`, `fan`, `louver`, `powerful`, `economy`, `program`, `schedule` |
| `POST /api/absence` | Programmer une absence `{ start, end }` (secondes Unix) |
| `DELETE /api/absence` | Annuler l'absence |

## Sécurité

- Secrets Cloudflare : `COZYTOUCH_EMAIL`, `COZYTOUCH_PASSWORD`, `COZYTOUCH_CLIENT_ID`,
  `ACCESS_KEYS`. Aucun n'apparaît dans le dépôt (`.dev.vars` est ignoré par Git).
- Clés d'accès : 24 à 256 caractères (lettres, chiffres, `-`, `_`), comparées en temps
  constant (empreintes SHA-256). Pour couper l'accès d'une personne, on retire son
  entrée du secret `ACCESS_KEYS`.
- Session : la clé n'est envoyée qu'à la connexion (`POST /api/session`). Le relais pose
  alors un cookie `HttpOnly; Secure; SameSite=Strict` limité à `/api` et valable
  180 jours. Le code de la page ne peut pas le lire, donc une faille d'affichage
  (XSS) ne permettrait pas de voler la clé.
- Requêtes qui modifient quelque chose (tout sauf `GET`) : refusées si l'en-tête
  `Origin` n'est pas celui de l'application (protection CSRF, en plus de `SameSite`).
  Corps limité à 1 Ko.
- Page : CSP stricte (`script-src 'self'`, `style-src 'self'`, sans code en ligne),
  HSTS, `frame-ancestors 'none'`, aucune ressource externe. Les données d'Atlantic
  sont insérées comme texte, jamais comme HTML.
- Programme : chaque jour est validé par le relais (horaires, écart, nombre de
  changements, degrés entiers dans les bornes, état Arrêt seulement si l'unité le
  déclare) puis réécrit par lui. Les valeurs envoyées par le téléphone ne sont jamais
  transmises telles quelles.
- Absence : les dates doivent être des entiers. Le départ ne peut pas être passé
  (5 min de tolérance), le retour doit le suivre d'au moins 15 min et arriver dans
  moins d'un an. Le PUT ne renvoie que les champs modifiables du logement.
- Commandes : la pièce doit exister dans le logement et être une pièce climatisée
  (le hub est refusé). Le réglage doit faire partie d'une liste fermée et la valeur
  doit être autorisée par l'unité : modes déclarés, bornes et pas de consigne,
  vitesses déclarées. L'identifiant d'exécution renvoyé par Atlantic doit être
  numérique avant d'être placé dans une URL. Chaque commande est journalisée dans
  Cloudflare (personne, pièce, réglage, résultat, durée), sans aucun secret.
- Réponses de l'API : `Cache-Control: no-store`, aucune autorisation cross-origin.
- Rapport de diagnostic : numéros de série, adresses, localisation et URL internes
  masqués. Les lectures facultatives (catalogue, consommation) peuvent échouer sans
  faire échouer le rapport.
- Limite connue : pas de limitation du nombre d'essais de connexion. Elle n'est pas
  disponible sur l'adresse gratuite `workers.dev`, et une clé générée (192 bits
  aléatoires) ne peut pas être devinée par force brute. Quelqu'un qui saturerait l'API
  pourrait épuiser le quota gratuit du jour (100 000 requêtes) ; l'application serait
  alors indisponible jusqu'au lendemain.

## Erreurs gérées

| Situation | Réponse du relais | Ce que voit l'utilisateur |
| --- | --- | --- |
| Clé fausse, session absente ou expirée | 401 `UNAUTHORIZED` | Retour à l'écran de connexion |
| Requête venue d'un autre site | 403 `FORBIDDEN_ORIGIN` | (ne concerne pas l'application) |
| Corps de requête illisible ou trop gros | 400 `BAD_REQUEST` | Message explicite |
| Secrets manquants | 503 `CONFIG` | Quel secret manque |
| Mot de passe Cozytouch refusé | 503 `AUTH_REFUSED` | Message explicite |
| Jeton Atlantic expiré | Reconnexion automatique (une fois) | Rien |
| Quota Atlantic dépassé | 429 `RATE_LIMITED` + délai | « Réessayez dans N s » |
| Atlantic lent ou injoignable | 504 `TIMEOUT` / 502 `UPSTREAM` | Message explicite |
| Pièce inconnue (ou le hub) | 404 `ROOM_NOT_FOUND` | Message explicite |
| Valeur ou réglage refusé par le relais | 422 `INVALID_VALUE`, `INVALID_STATE`, `UNKNOWN_SETTING`, `UNAVAILABLE` | Message explicite, rien n'est envoyé |
| Écriture rejetée par Atlantic | 502 `COMMAND_REFUSED` | « Atlantic a refusé la commande » |
| L'unité n'applique pas la commande | 502 `COMMAND_FAILED` | « L'unité n'a pas pu appliquer la commande » |
| Pas de confirmation dans les 9 s | 202 `pending` | « Envoyé, Atlantic n'a pas encore confirmé » |

## Phases

1. **Découverte** : relais et page de diagnostic en lecture seule. *(terminée)*
2. **Application** : tableau de bord Salon / Chambre, toutes les commandes exposées,
   suivi de chaque commande (envoyée, confirmée, échec) avec son délai. *(terminée)*
3. **Programmation et finition** : éditeur du programme hebdomadaire, mode Absence
   (toute la maison), icône et installation PWA, README final. *(terminée, essai
   guidé sur les unités à faire)*
