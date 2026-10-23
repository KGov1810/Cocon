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
