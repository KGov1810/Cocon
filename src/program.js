/**
 * Programme hebdomadaire d'une pièce.
 *
 * Chaque unité stocke deux programmes (chaud et froid) de 7 jours, lundi en
 * premier. Un jour est une chaîne JSON de 10 triplets [minute, consigne, état] :
 *   - minute : début du créneau, en minutes depuis minuit (heure du logement) ;
 *   - consigne : température en degrés entiers ;
 *   - état : « état étendu » du créneau. 0 = normal, 1 = Arrêt (l'unité s'éteint),
 *     d'après le catalogue Atlantic (capacité 100013 : 1 = Off, 2 = Boost).
 * Les emplacements inutilisés valent [0,0,0].
 *
 * L'encodage de l'Arrêt (état 1) suit le catalogue mais doit être confirmé sur
 * l'unité : voir l'essai guidé dans le README.
 */

import { CommandError } from "./errors.js";

export const PROGRAM_CAP = {
  mode: 184, // 0 BASIC (manuel), 1 PROG (programme)
  modeCapabilities: 217, // bit 2 : programme disponible
  override: 157,
  overrideDuration: 158,
  overrideRemaining: 159,
  step: 295,
  minGap: 296,
  maxPerDay: 306,
  minPerWeek: 348,
  extendedStates: 100013,
  heat: 100320, // lundi ; +1 par jour jusqu'à dimanche
  cool: 100327,
};

const PROGRAM_BIT = 2;
const EXTENDED_OFF = 1;
const STORED_SLOTS = 10;
const DAYS = 7;
const DAY_MINUTES = 1440;
const MAX_OVERRIDE_MINUTES = 1440;

/** Lit un jour stocké ; une valeur illisible donne un jour vide. */
export function parseDay(raw) {
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const slots = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const [minutes, setpoint, state = 0] = row.map(Number);
    if (minutes === 0 && setpoint === 0 && state === 0) continue; // emplacement vide
    if (!Number.isInteger(minutes) || minutes < 0 || minutes >= DAY_MINUTES || !Number.isFinite(setpoint)) continue;
    const off = (state & EXTENDED_OFF) !== 0;
    slots.push({ minutes, setpoint: off ? null : setpoint, off });
  }
  return slots.sort((a, b) => a.minutes - b.minutes);
}

/** Écrit un jour au format de l'unité ; `offSetpoint` remplit la consigne des créneaux Arrêt. */
export function serializeDay(slots, offSetpoint) {
  const rows = slots.map((s) => (s.off ? [s.minutes, offSetpoint, EXTENDED_OFF] : [s.minutes, s.setpoint, 0]));
  while (rows.length < STORED_SLOTS) rows.push([0, 0, 0]);
  return JSON.stringify(rows);
}

/** Jour (0 = lundi) et minute courants à l'heure du logement. */
export function localClock(now, offsetSeconds) {
  const d = new Date(now + offsetSeconds * 1000);
  return { day: (d.getUTCDay() + 6) % 7, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Prochain créneau après l'instant donné, sur une semaine glissante ; null s'il n'y en a aucun. */
export function nextChange(days, clock) {
  for (let ahead = 0; ahead <= DAYS; ahead += 1) {
    const day = (clock.day + ahead) % DAYS;
    for (const slot of days[day]) {
      if (ahead === 0 && slot.minutes <= clock.minutes) continue;
      return {
        day,
        minutes: slot.minutes,
        inMinutes: ahead * DAY_MINUTES + slot.minutes - clock.minutes,
        setpoint: slot.setpoint,
        off: slot.off,
      };
    }
  }
  return null;
}

/** Programme suivi dans un mode donné (null : aucun, par exemple en ventilation). */
export function scheduleKindFor(mode) {
  if (mode === "heat") return "heat";
  if (mode === "cool" || mode === "dry") return "cool";
  return null;
}

/**
 * Programme d'une pièce, ou undefined si l'unité n'en propose pas.
 * @param {(id: number) => string | undefined} get  valeur brute d'une capacité
 * @param {{ mode: string, now: number, offsetSeconds: number }} context
 */
export function readProgram(get, { mode, now, offsetSeconds }) {
  const int = (id) => {
    const n = Number.parseInt(get(id), 10);
    return Number.isInteger(n) ? n : null;
  };
  if (get(PROGRAM_CAP.mode) === undefined) return undefined;
  const modeMask = int(PROGRAM_CAP.modeCapabilities);
  if (modeMask !== null && (modeMask & PROGRAM_BIT) === 0) return undefined;

  const week = (base) => {
    const raw = Array.from({ length: DAYS }, (_, i) => get(base + i));
    return raw.every((v) => v !== undefined) ? raw.map(parseDay) : null;
  };
  const heat = week(PROGRAM_CAP.heat);
  const cool = week(PROGRAM_CAP.cool);
  if (!heat && !cool) return undefined;

  const active = String(get(PROGRAM_CAP.mode)) === "1";
  const kind = scheduleKindFor(mode);
  const followed = kind === "heat" ? heat : kind === "cool" ? cool : null;

  return {
    available: true,
    active,
    offAvailable: ((int(PROGRAM_CAP.extendedStates) ?? 0) & EXTENDED_OFF) !== 0,
    limits: {
      step: int(PROGRAM_CAP.step) || 15,
      minGap: int(PROGRAM_CAP.minGap) ?? 60,
      maxPerDay: Math.min(int(PROGRAM_CAP.maxPerDay) || 8, STORED_SLOTS),
      minPerWeek: int(PROGRAM_CAP.minPerWeek) ?? 0,
    },
    heat,
    cool,
    override: {
      active: String(get(PROGRAM_CAP.override)) === "1",
      remainingMinutes: int(PROGRAM_CAP.overrideRemaining) ?? 0,
    },
    next: active && followed ? nextChange(followed, localClock(now, offsetSeconds)) : null,
  };
}

const invalid = (message) => new CommandError("INVALID_VALUE", message);

function readSlot(slot, range, program) {
  if (!slot || typeof slot !== "object") throw invalid("Créneau invalide.");
  const { minutes } = slot;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= DAY_MINUTES || minutes % program.limits.step !== 0) {
    throw invalid(`Les horaires se règlent par pas de ${program.limits.step} min, entre 00:00 et 23:59.`);
  }
  if (slot.off === true) {
    if (!program.offAvailable) throw invalid("Cette unité ne propose pas de créneau Arrêt.");
    return { minutes, setpoint: null, off: true };
  }
  if (slot.off !== undefined && slot.off !== false) throw invalid("Créneau invalide.");
  const { setpoint } = slot;
  if (!Number.isInteger(setpoint) || setpoint < range.min || setpoint > range.max) {
    throw invalid(`Consigne du programme : un degré entier entre ${range.min} et ${range.max} °C.`);
  }
  return { minutes, setpoint, off: false };
}

/**
 * Valide un jour de programme et le traduit en une écriture par jour visé.
 * @param {object} program  programme lu par readProgram
 * @param {{ kind: "heat" | "cool", days: number[], slots: object[] }} value
 * @param {{ heat: { min: number, max: number }, cool: { min: number, max: number } }} ranges
 */
export function planSchedule(program, value, ranges) {
  if (!program?.available) throw new CommandError("UNKNOWN_SETTING", "Programme indisponible sur cette unité.");
  if (!value || typeof value !== "object") throw invalid("Programme invalide.");
  const { kind, days, slots } = value;
  if ((kind !== "heat" && kind !== "cool") || !program[kind]) throw invalid("Programme inconnu.");
  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    new Set(days).size !== days.length ||
    !days.every((d) => Number.isInteger(d) && d >= 0 && d < DAYS)
  ) {
    throw invalid("Jours invalides.");
  }
  if (!Array.isArray(slots)) throw invalid("Créneaux absents.");
  if (slots.length > program.limits.maxPerDay) {
    throw invalid(`Au plus ${program.limits.maxPerDay} changements par jour.`);
  }

  const range = { min: Math.ceil(ranges[kind].min), max: Math.floor(ranges[kind].max) };
  const clean = slots.map((slot) => readSlot(slot, range, program)).sort((a, b) => a.minutes - b.minutes);
  for (let i = 1; i < clean.length; i += 1) {
    if (clean[i].minutes - clean[i - 1].minutes < program.limits.minGap) {
      throw invalid(`Il faut au moins ${program.limits.minGap} min entre deux changements.`);
    }
  }

  const weekTotal = program[kind].reduce((sum, day, i) => sum + (days.includes(i) ? clean.length : day.length), 0);
  if (weekTotal < program.limits.minPerWeek) {
    throw invalid("Le programme doit garder au moins un changement dans la semaine.");
  }

  const stored = serializeDay(clean, range.min);
  return [...days].sort((a, b) => a - b).map((day) => ({ capabilityId: PROGRAM_CAP[kind] + day, value: stored }));
}

/** Écritures de dérogation avant un changement de consigne pendant un programme actif. */
export function overrideWrites(program, has) {
  if (!program?.active || !has(PROGRAM_CAP.override)) return [];
  const writes = [];
  if (program.next && has(PROGRAM_CAP.overrideDuration)) {
    const minutes = Math.min(MAX_OVERRIDE_MINUTES, Math.max(1, Math.ceil(program.next.inMinutes)));
    writes.push({ capabilityId: PROGRAM_CAP.overrideDuration, value: String(minutes) });
  }
  writes.push({ capabilityId: PROGRAM_CAP.override, value: "1" });
  return writes;
}
