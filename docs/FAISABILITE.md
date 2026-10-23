# Analyse de faisabilité

Installation étudiée : pompe à chaleur air/air **Atlantic Takao Plus** en multi-split
(une unité extérieure, deux unités intérieures ASYH 7 KJCA.UI : Salon et Chambre),
reliée par le **Hub Cozytouch**. Utilisateurs : 2 personnes sur iPhone, même compte
Cozytouch, mêmes droits.

## 1. Quelle API utiliser ?

| Piste | Verdict | Raison |
| --- | --- | --- |
| Overkiz / pyoverkiz | ❌ Inutilisable | Les hubs Naviclim / Hub Cozytouch des climatiseurs ne passent pas par la plateforme Overkiz (confirmé par les mainteneurs de l'intégration Overkiz de Home Assistant). |
| API locale du hub | ❌ Inexistante | Le Hub Cozytouch n'expose aucune API locale. |
| Zigbee local (Zigbee2MQTT) | ⏸️ Écartée pour l'instant | Fonctionne (l'interface de chaque Takao est un module Zigbee 3.0 certifié), mais demande une clé Zigbee et un appareil allumé en permanence : incompatible avec l'objectif « 0 € ». |
| **Cloud Atlantic « Magellan »** | ✅ **Retenue** | C'est l'API qu'utilise l'application Cozytouch pour ce matériel (`apis.groupe-atlantic.com`). Non officielle, mais déjà utilisée par des projets open source (gduteil/cozytouch pour Home Assistant, homey-cozytouch). |

## 2. Fonctions réellement exposées (confirmées sur l'installation, octobre 2026)

Lues par la page `/diagnostic` sur les deux unités (`ROOM_0` = Chambre,
`ROOM_1` = Salon, modèles 557 et 558), derrière le Hub Cozytouch (modèle 1457).

| Fonction | Capacité Atlantic | Dans Cocon |
| --- | --- | --- |
| Mode : arrêt, auto, froid, chaud, ventilation, déshumidification | 7 (valeurs permises par le masque 166 = 411) | Oui |
| Consigne chaud (16 à 30 °C) et froid (18 à 30 °C), pas de 0,5 °C | 40, 177 (bornes 160 à 163, pas 294) | Oui |
| Température mesurée | 117, validité 103150 | Oui (affichée « — » hors 4 à 40 °C, par exemple −50 °C quand l'unité est arrêtée) |
| Ventilation : basse, moyenne, haute, auto | 100801 (séquence 100800 = 2) | Oui |
| Silence | 100802 | Oui |
| Volets : 6 positions fixes ou balayage | 100803, 100804 | Oui (positions 5 et 6 à confirmer sur l'unité) |
| Pleine puissance | 100505 | Oui |
| Économie d'énergie | 100507 (activée sur les deux unités) | Oui, marquée expérimentale : absente de l'appli Cozytouch, effet non documenté |
| Programme hebdomadaire chaud et froid (2 à 8 plages par jour) | 184 (BASIC / PROG), 100320 à 100333, dérogation 157 et 158 | Phase 3 (dérogation déjà gérée) |
| Absence (toute la maison) | Hub : 152, 172, 222 | Phase 3 |
| Indicateur « chauffe / refroidit en cours » | 153 | Non : sa valeur ne change jamais sur cette installation |
| Mode éco du catalogue (préréglage) | — | Absent de l'installation |

> Les capacités déclarées par l'unité sont la seule source : l'interface n'affiche
> que ce qui existe. Le relais refuse toute valeur hors de ce que l'unité déclare.

## 3. Réactivité

Mesures faites par l'utilisateur, en mode chauffage :

| Trajet | Délai |
| --- | --- |
| Télécommande → arrivée d'air chaud | 5 à 10 min |
| Appli Cozytouch → réaction de l'unité | 1 à 2 min |

Conclusions :

- **L'essentiel du délai vient de la PAC elle-même** (montée en température de
  l'échangeur avant de souffler). Aucune application ne peut le réduire.
- **Le cloud ajoute 1 à 2 min.** Dans l'API, une commande est une « exécution » qui
  passe par les états *en attente → en cours → terminée*. Cocon affiche le temps
  mis par Atlantic pour confirmer chaque commande. Si la confirmation arrive en
  quelques secondes alors que l'unité réagit 1 à 2 min plus tard, le délai se situe
  entre le cloud et le hub ou l'unité, hors de portée d'une application.
- La lecture complète de l'état prend environ 1,9 s chez Atlantic.
- **Ce que Cocon améliore réellement** : un retour visuel immédiat (envoi, confirmation
  du cloud, échec), un état rafraîchi plus souvent pendant qu'on regarde l'écran, et
  surtout la **programmation hebdomadaire**, qui met la pièce à température à l'heure
  voulue sans attendre.

## 4. Consommation et tarifs

**Confirmé : non disponible.** Aucune unité ne publie la capacité 164
(consommations suivies), et la route de consommation du logement répond par une
liste vide. Cela concorde avec Atlantic, qui exclut les pompes à chaleur air/air
du suivi de consommation. Il n'y a donc pas d'écran « Énergie ».

## 5. Contraintes et risques

| Risque | Effet | Parade |
| --- | --- | --- |
| API non officielle | Peut changer sans préavis | Code isolé dans `src/atlantic.js` ; page de diagnostic pour comprendre vite ce qui a changé. |
| Quota Atlantic (~30 requêtes/min déclarées, partagées avec l'appli officielle) | Blocage temporaire (HTTP 429) | Une seule requête lit tout le logement ; rafraîchissement rapide seulement pendant l'utilisation ; message clair en cas de dépassement. |
| Multi-split | Une unité se met en attente si Salon et Chambre demandent des modes opposés | Avertissement dans l'interface (phase 2). |
| Jeton expiré, hub hors ligne, commande refusée | Échec d'une action | Reconnexion automatique, états « hors ligne » et messages d'erreur en français. |
| Identifiants | Fuite du mot de passe Cozytouch | Stockés uniquement comme secrets chiffrés chez Cloudflare ; jamais dans le code, le dépôt ni le téléphone. |

## Sources

- [Home Assistant, issue #75394](https://github.com/home-assistant/core/issues/75394) : les hubs Naviclim ne sont pas des hubs Overkiz.
- [gduteil/cozytouch](https://github.com/gduteil/cozytouch) : intégration Home Assistant pour le cloud Magellan (routes, capacités, consommation).
- [homey-cozytouch](https://community.homey.app/t/app-pro-atlantic-cozytouch-en/159117) : les deux clouds d'Atlantic.
- [Zigbee2MQTT, interface Naviclim GW003-AS-IN-TE-FC](https://www.zigbee2mqtt.io/devices/GW003-AS-IN-TE-FC.html).
- [Fiche technique Takao Plus](https://cdn.hellowatt.fr/media/product_pages/takao-plus/Fiche_technique_Takao_Plus.pdf).
