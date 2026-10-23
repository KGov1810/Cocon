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

/** Consigne suivante (+1 ou −1 pas), bornée ; null si la consigne ne se règle pas. */
export function stepSetpoint(room, direction) {
  const range = room.setpointRange;
  if (!range || room.setpoint === null) return null;
  const next = Math.round((room.setpoint + direction * range.step) / range.step) * range.step;
  return Math.min(range.max, Math.max(range.min, next));
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
