/**
 * Logique d'affichage du tableau de bord, sans accès au DOM ni au réseau
 * (testée par test/logic.test.js).
 */

const oneDecimal = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

/** 21.5 → « 21,5° » ; null → « — ». */
export function formatTemperature(value) {
  return value === null || value === undefined ? "—" : `${oneDecimal.format(value)}°`;
}

function formatDuration(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${oneDecimal.format(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

/** Phrase affichée sous une pièce après l'envoi d'une commande. */
export function describeOutcome({ status, elapsedMs }) {
  return status === "confirmed"
    ? `Confirmé par Atlantic en ${formatDuration(elapsedMs)}`
    : "Envoyé. Atlantic n'a pas encore confirmé, l'affichage se mettra à jour.";
}

const HEATING = new Set(["heat"]);
const COOLING = new Set(["cool", "dry"]);

/**
 * Autre pièce qui fonctionne dans le sens opposé (chaud contre froid) :
 * avec une seule unité extérieure, l'une des deux se met alors en attente.
 */
export function conflictWith(rooms, roomId, mode) {
  const opposite = HEATING.has(mode) ? COOLING : COOLING.has(mode) ? HEATING : null;
  if (!opposite) return null;
  return rooms.find((r) => r.id !== roomId && r.available && opposite.has(r.mode)) ?? null;
}

/**
 * Mode utilisé par le bouton « Allumer » : le dernier mode choisi s'il existe
 * encore, sinon le chauffage d'octobre à avril et le froid le reste de l'année.
 * @param {number} month  0 = janvier
 */
export function powerOnMode(room, remembered, month) {
  const usable = (mode) => mode && mode !== "off" && room.modes.includes(mode);
  if (usable(remembered)) return remembered;
  const season = month >= 9 || month <= 3 ? ["heat", "cool"] : ["cool", "heat"];
  return season.find(usable) ?? room.modes.find(usable) ?? null;
}

/**
 * Superpose les valeurs demandées mais pas encore visibles chez Atlantic.
 * Une valeur est oubliée dès qu'Atlantic la renvoie, ou passé son délai.
 *
 * @param {object[]} rooms  état reçu du relais
 * @param {Map<number, Record<string, { value: unknown, until: number }>>} optimistic
 * @param {number} now
 */
export function applyOptimistic(rooms, optimistic, now) {
  const kept = new Map();
  const merged = rooms.map((room) => {
    const patches = optimistic.get(room.id);
    if (!patches) return room;
    const copy = { ...room };
    const still = {};
    for (const [field, patch] of Object.entries(patches)) {
      if (now > patch.until || room[field] === patch.value) continue;
      copy[field] = patch.value;
      still[field] = patch;
    }
    if (Object.keys(still).length) kept.set(room.id, still);
    return copy;
  });
  return { rooms: merged, optimistic: kept };
}

/* ---------- Programme hebdomadaire ---------- */

const DAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

/** 390 → « 06:30 ». */
export function formatClock(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Prochain changement du programme, en clair.
 * @param {{ day: number, minutes: number, setpoint: number | null, off: boolean }} next
 * @param {number} today  0 = lundi
 */
export function describeNext(next, today) {
  const what = next.off ? "arrêt" : formatTemperature(next.setpoint);
  let when = "";
  if (next.day === (today + 1) % 7) when = "demain ";
  else if (next.day !== today) when = `${DAY_NAMES[next.day]} `;
  return `${what} ${when}à ${formatClock(next.minutes)}`;
}

/** Jours visés par « appliquer à » (0 = lundi). */
export function daysFor(applyTo, day) {
  if (applyTo === "weekdays") return [0, 1, 2, 3, 4];
  if (applyTo === "weekend") return [5, 6];
  if (applyTo === "week") return [0, 1, 2, 3, 4, 5, 6];
  return [day];
}

/**
 * Vérifie un jour de programme avant l'envoi (mêmes règles que le relais).
 * @param {number} otherSlots  créneaux des jours non modifiés
 * @returns {string | null} message d'erreur, ou null si le jour est valide
 */
export function validateDraft(slots, limits, otherSlots) {
  if (slots.length > limits.maxPerDay) return `Au plus ${limits.maxPerDay} changements par jour.`;
  const sorted = [...slots].sort((a, b) => a.minutes - b.minutes);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].minutes - sorted[i - 1].minutes < limits.minGap) {
      return `Il faut au moins ${limits.minGap} min entre deux changements.`;
    }
  }
  if (slots.length + otherSlots < limits.minPerWeek) {
    return "Le programme doit garder au moins un changement dans la semaine.";
  }
  return null;
}

/* ---------- Absence ---------- */

function formatMoment(seconds, timeZone) {
  const date = new Date(seconds * 1000);
  const day = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone });
  const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone });
  return `${day.format(date)} à ${time.format(date)}`;
}

/** Phrase du bandeau d'absence ; null s'il n'y a pas d'absence. */
export function describeAbsence(absence, timeZone) {
  if (!absence || absence.status === "off" || !absence.end) return null;
  if (absence.status === "on") return `Absence en cours jusqu'au ${formatMoment(absence.end, timeZone)}`;
  return `Absence programmée du ${formatMoment(absence.start, timeZone)} au ${formatMoment(absence.end, timeZone)}`;
}

/* ---------- Écran d'une pièce : chiffre, niveau, vague et gestes ---------- */

/** Libellés des modes, en entier (titres) et en court (onglets, tuiles, choix). */
export const MODE_LABEL = {
  off: "Arrêt",
  heat: "Chauffage",
  cool: "Froid",
  auto: "Auto",
  fan: "Ventilation",
  dry: "Déshumidification",
  unknown: "État inconnu",
};
export const MODE_SHORT = { ...MODE_LABEL, dry: "Déshum.", fan: "Ventil." };
export const FAN_LABEL = { auto: "Auto", low: "Basse", medium: "Moyenne", high: "Haute", quiet: "Silence" };

const ADJUSTABLE = new Set(["heat", "cool", "auto", "dry"]);

/** L'unité tourne (ni arrêtée, ni dans un état inconnu, ni hors ligne). */
export function isRunning(room) {
  return Boolean(room.available) && room.mode !== "off" && room.mode !== "unknown";
}

/** La consigne existe dans ce mode et se règle maintenant. */
export function canAdjust(room) {
  return Boolean(room.available && ADJUSTABLE.has(room.mode) && room.setpointRange && room.setpoint !== null);
}

const STATUS_VISIBLE_MS = 45_000;

/** Retour de commande encore à montrer : l'envoi en cours, ou un résultat de moins de 45 s ; sinon null. */
export function shownStatus(status, now) {
  if (!status) return null;
  return status.kind === "sending" || status.kind === "draft" || now - status.at < STATUS_VISIBLE_MS ? status : null;
}

/**
 * Ligne d'état sous le chiffre.
 * @param {{ absent?: boolean, onMode?: string | null }} context  absence en cours ; mode de rallumage
 */
export function describeRoom(room, { absent, onMode } = {}) {
  if (!room.available) return "Unité injoignable : vérifiez le hub Cozytouch.";
  if (absent) return "Arrêtée pendant l'absence";
  const t = typeof room.temperature === "number" ? room.temperature : null;
  switch (room.mode) {
    case "heat":
      return t !== null && t >= room.setpoint ? "Consigne atteinte, l'unité ralentit" : "Chauffe pour atteindre la consigne";
    case "cool":
      return t !== null && t <= room.setpoint ? "Consigne atteinte, l'unité ralentit" : "Refroidit pour atteindre la consigne";
    case "auto":
      return "Chauffe ou refroidit selon la pièce";
    case "dry":
      return "Déshumidifie la pièce";
    case "fan":
      return "Ventilation seule, sans consigne";
    case "unknown":
      return "État inconnu : actualisez dans un instant";
    default:
      return onMode ? `À l'arrêt · se rallumera en ${MODE_LABEL[onMode].toLowerCase()}` : "À l'arrêt";
  }
}

const DEFAULT_RANGE = { min: 16, max: 30, step: 0.5 };

/** 21.5 → { whole: "21", decimal: ",5" } : l'entier s'affiche en grand, la décimale à côté. */
export function splitTemperature(value) {
  if (value === null || value === undefined) return { whole: "—", decimal: "" };
  const [whole, decimal] = oneDecimal.format(value).split(",");
  return { whole, decimal: decimal ? `,${decimal}` : "" };
}

/** Hauteur du niveau coloré (part de l'écran) : 12 % à la consigne minimale, 82 % à la maximale. */
export function fillLevel(room) {
  const range = room.setpointRange ?? DEFAULT_RANGE;
  if (room.setpoint === null || room.setpoint === undefined) return 0.12;
  const ratio = Math.min(1, Math.max(0, (room.setpoint - range.min) / (range.max - range.min)));
  return Math.round((0.12 + 0.7 * ratio) * 1e4) / 1e4;
}

const FIXED_FAN = { quiet: 0.25, low: 0.4, medium: 0.6, high: 0.85 };

/**
 * Force du souffle, de 0 à 1, pour animer la vague. C'est une estimation tirée
 * des réglages : Atlantic ne publie ni la puissance ni la vitesse réelle.
 */
export function waveLevel(room) {
  if (room.available === false || room.mode === "off" || room.mode === "unknown") return 0;
  if (room.powerful) return 1;
  let level = 0.4;
  const known = typeof room.temperature === "number" && typeof room.setpoint === "number";
  if (FIXED_FAN[room.fan] !== undefined) level = FIXED_FAN[room.fan];
  else if (known && room.mode === "heat") level = 0.25 + Math.max(0, room.setpoint - room.temperature) * 0.2;
  else if (known && (room.mode === "cool" || room.mode === "dry")) level = 0.25 + Math.max(0, room.temperature - room.setpoint) * 0.2;
  else if (known && room.mode === "auto") level = 0.25 + Math.abs(room.setpoint - room.temperature) * 0.2;
  level = Math.min(1, level);
  return room.economy ? level * 0.75 : level;
}

/**
 * Consigne visée pendant un glissement vertical : un pas tous les `pxPerStep`
 * pixels vers le haut. `overshoot` mesure, en pixels, le dépassement des bornes
 * (positif au-dessus du maximum, négatif sous le minimum) pour l'effet élastique.
 * @returns {{ value: number, overshoot: number } | null}
 */
export function setpointFromDrag(room, start, dy, pxPerStep = 22) {
  const range = room.setpointRange;
  if (!range || start === null || start === undefined) return null;
  const raw = start + (dy / pxPerStep) * range.step;
  const value = Math.min(range.max, Math.max(range.min, Math.round(raw / range.step) * range.step));
  let overshoot = 0;
  if (raw > range.max) overshoot = ((raw - range.max) / range.step) * pxPerStep;
  else if (raw < range.min) overshoot = ((raw - range.min) / range.step) * pxPerStep;
  return { value, overshoot };
}

/** Résistance progressive au-delà d'une borne : plus on tire, moins ça suit. */
export function rubberBand(overshoot, size, constant = 0.55) {
  return (overshoot * size * constant) / (size + constant * Math.abs(overshoot));
}

/** Glissement horizontal assez ample, ou assez vif, pour changer de pièce. */
export function isFlick(dx, elapsedMs) {
  const distance = Math.abs(dx);
  return distance >= 70 || (distance > 24 && distance / Math.max(1, elapsedMs) > 0.25);
}

/** Résumé de la tuile « Options » ; null si l'unité n'a ni pleine puissance ni économie. */
export function optionsSummary(room) {
  if (room.powerful === undefined && room.economy === undefined) return null;
  if (room.powerful && room.economy) return "Puissance + éco";
  if (room.powerful) return "Puissance";
  if (room.economy) return "Économie";
  return "Aucune";
}
