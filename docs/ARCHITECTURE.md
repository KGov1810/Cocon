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
| Client Atlantic | Seul endroit qui connaît l'API Magellan : connexion, jeton en cache, reconnexion sur 401, gestion du quota (429) et des délais. | `src/atlantic.js` |
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
jour forcées, et rien à « construire » avant de publier.

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

## Phases

1. **Découverte** : relais et page de diagnostic en lecture seule.
2. **Application** : tableau de bord Salon / Chambre, toutes les commandes exposées,
   suivi de chaque commande (envoyée, confirmée, échec) avec son délai.
3. **Programmation et finition** : éditeur du programme hebdomadaire, icône et
   installation PWA, README final.
