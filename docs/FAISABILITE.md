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

## 2. Fonctions attendues

D'après la cartographie publiée par l'intégration open source pour les climatiseurs
Takao (établie sur d'autres modèles que le Takao Plus) :

| Fonction | Exposée ? |
| --- | --- |
| Marche / arrêt, modes auto, froid, chaud, ventilation, déshumidification | Oui |
| Température de consigne, température mesurée | Oui |
| Vitesse de ventilation : basse, moyenne, haute, auto | Oui |
| Mode silencieux | Oui |
| Orientation des volets (4 positions) | Oui |
| Mode absence (pour tout le logement) | Oui |
| Programme hebdomadaire chauffage / refroidissement (10 plages par jour max., degrés entiers) | Oui |
| Mode éco | Non |
| Consommation et coût | Très probablement non (voir §4) |

> **À confirmer sur l'installation réelle** : Atlantic répond « par produit » et non
> « par modèle ». La page `/diagnostic` de Cocon (phase 1) liste ce que vos deux unités
> exposent vraiment ; l'interface ne montrera que ces fonctions.

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
  passe par les états *en attente → en cours → terminée*, et le cloud confirme en
  quelques secondes. Le délai restant se situe donc probablement entre le cloud et
  le hub ou l'unité. C'est une hypothèse, que les commandes de la phase 2
  mesureront (horodatage de chaque étape).
- **Ce que Cocon améliore réellement** : un retour visuel immédiat (envoi, confirmation
  du cloud, échec), un état rafraîchi plus souvent pendant qu'on regarde l'écran, et
  surtout la **programmation hebdomadaire**, qui met la pièce à température à l'heure
  voulue sans attendre.

## 4. Consommation et tarifs

La route de consommation existe dans l'API (kWh et coût par jour, heures pleines et
creuses), mais tout indique qu'elle ne renvoie rien pour cette installation :

- Atlantic exclut les pompes à chaleur air/air du suivi de consommation de son boîtier Cozybox.
- L'interface Zigbee des Takao ne mesure ni puissance ni énergie.
- Sur un hub Atlantic pour climatiseurs, l'indicateur « consommation disponible »
  (capacité 164) vaut 0.

Le diagnostic le vérifie. Sans données, l'écran « Énergie » ne sera pas construit.

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
