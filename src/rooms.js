/**
 * Modèle des pièces climatisées.
 *
 * - readRooms() transforme la vue brute d'Atlantic (« setupviewv2 ») en pièces
 *   lisibles par l'application, en ne gardant que les réglages que l'unité
 *   déclare réellement.
 * - planCommand() valide une demande de l'application et la traduit en
 *   écritures de capacités Atlantic. Toute valeur non prévue est refusée.
 *
 * Les numéros de capacités et leurs valeurs viennent du catalogue Atlantic lu
 * par la page de diagnostic sur une installation Takao Plus réelle.
 */

import { CommandError } from "./errors.js";
import { overrideWrites, planSchedule, PROGRAM_CAP, readProgram } from "./program.js";

export { CommandError };

/** Décalage horaire du logement, en secondes (porté par le hub). */
const TIME_OFFSET_CAP = 315;

/** Numéros des capacités Atlantic utilisées. */
const CAP = {
  mode: 7,
  heatSetpoint: 40,
  temperature: 117,
  name: 154,
  minHeat: 160,
  maxHeat: 161,
  minCool: 162,
  maxCool: 163,
  modes: 166,
  coolSetpoint: 177,
  step: 294,
  powerful: 100505,
  economy: 100507,
  fanSequence: 100800,
  fanSpeed: 100801,
  quiet: 100802,
  louver: 100803,
  swing: 100804,
  temperatureValid: 103150,
};

/** Modes de l'application → valeur de la capacité 7, et bit dans la capacité 166. */
const MODES = [
  { name: "off", value: "0", bits: 1 },
  { name: "auto", value: "1", bits: 2 | 4 }, // AutoTemp ou AutoSeason
  { name: "cool", value: "3", bits: 8 },
  { name: "heat", value: "4", bits: 16 },
  { name: "fan", value: "7", bits: 128 },
  { name: "dry", value: "8", bits: 256 },
];

/** Vitesses de ventilation → valeur de la capacité 100801. */
const FAN_VALUES = { low: "1", medium: "2", high: "3", auto: "5" };

/** Séquences de vitesses déclarées par la capacité 100800. */
const FAN_SEQUENCES = {
  0: ["low", "medium", "high"],
  1: ["low", "high"],
  2: ["auto", "low", "medium", "high"],
  3: ["auto", "low", "high"],
};

/**
 * Positions fixes des volets. Le catalogue Atlantic en annonce 6 (Fujitsu),
 * mais l'essai sur le Takao Plus n'en a trouvé que 4.
 */
const LOUVER_POSITIONS = ["1", "2", "3", "4"];

/** Plage de mesure valide de la température ambiante (catalogue, capacité 117). */
const TEMPERATURE_RANGE = { min: 4, max: 40 };

/** Capacités présentes sur l'unité, gardées hors de la réponse JSON. */
const CAPS = Symbol("capabilities");

const toNumber = (raw) => {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
};

/** Arrondi à deux décimales (les valeurs Atlantic arrivent en 22 décimales). */
const round = (n) => (n === null ? null : Math.round(n * 100) / 100);

function readOne(device, zones, { now, offsetSeconds }) {
  const caps = new Map((device.capabilities ?? []).map((c) => [c.capabilityId, c.value]));
  const has = (id) => caps.has(id);
  const num = (id) => round(toNumber(caps.get(id)));

  const modeEntry = MODES.find((m) => m.value === String(caps.get(CAP.mode)));
  const mode = modeEntry?.name ?? "unknown";

  const modeMask = toNumber(caps.get(CAP.modes));
  const modes =
    modeMask === null
      ? MODES.map((m) => m.name)
      : MODES.filter((m) => (modeMask & m.bits) !== 0).map((m) => m.name);

  const step = num(CAP.step) ?? 0.5;
  const heatRange = { min: num(CAP.minHeat) ?? 16, max: num(CAP.maxHeat) ?? 30, step };
  const coolRange = { min: num(CAP.minCool) ?? 18, max: num(CAP.maxCool) ?? 30, step };

  let setpoint = num(CAP.heatSetpoint);
  let setpointRange = heatRange;
  if (mode === "cool" || mode === "dry") {
    setpoint = num(CAP.coolSetpoint);
    setpointRange = coolRange;
  } else if (mode === "auto") {
    setpointRange = {
      min: Math.max(heatRange.min, coolRange.min),
      max: Math.min(heatRange.max, coolRange.max),
      step,
    };
  } else if (mode === "fan" || mode === "unknown") {
    setpoint = null;
    setpointRange = null;
  }

  const measured = num(CAP.temperature);
  const temperatureValid =
    measured !== null &&
    String(caps.get(CAP.temperatureValid) ?? "1") !== "0" &&
    measured >= TEMPERATURE_RANGE.min &&
    measured <= TEMPERATURE_RANGE.max;

  const zoneName = zones.get(device.zoneId);
  const ownName = String(caps.get(CAP.name) ?? "").trim();

  const room = {
    id: device.deviceId,
    name: ownName || zoneName || device.name || `Unité ${device.deviceId}`,
    available: device.isAvailable !== false,
    mode,
    modes,
    setpoint,
    setpointRange,
    temperature: temperatureValid ? measured : null,
  };

  const program = readProgram((id) => caps.get(id), { mode, now, offsetSeconds });
  if (program) {
    // Bornes des consignes du programme, en degrés entiers.
    const whole = (range) => ({ min: Math.ceil(range.min), max: Math.floor(range.max) });
    room.program = { ...program, ranges: { heat: whole(heatRange), cool: whole(coolRange) } };
  }

  const sequence = FAN_SEQUENCES[String(caps.get(CAP.fanSequence))];
  if ((has(CAP.fanSpeed) && sequence) || has(CAP.quiet)) {
    room.fanSpeeds = [...(has(CAP.fanSpeed) && sequence ? sequence : []), ...(has(CAP.quiet) ? ["quiet"] : [])];
    const speed = Object.keys(FAN_VALUES).find((k) => FAN_VALUES[k] === String(caps.get(CAP.fanSpeed)));
    room.fan = String(caps.get(CAP.quiet)) === "1" ? "quiet" : (speed ?? null);
  }

  if (has(CAP.louver) || has(CAP.swing)) {
    room.louvers = [...(has(CAP.swing) ? ["swing"] : []), ...(has(CAP.louver) ? LOUVER_POSITIONS : [])];
    const position = String(caps.get(CAP.louver));
    room.louver =
      String(caps.get(CAP.swing)) === "1"
        ? "swing"
        : LOUVER_POSITIONS.includes(position)
          ? position
          : null;
  }

  if (has(CAP.powerful)) room.powerful = String(caps.get(CAP.powerful)) === "1";
  if (has(CAP.economy)) room.economy = String(caps.get(CAP.economy)) === "1";

  Object.defineProperty(room, CAPS, { value: new Set(caps.keys()), enumerable: false });
  return room;
}

/** Décalage horaire du logement en secondes (0 si aucun appareil ne le donne). */
function timeOffset(devices) {
  for (const device of devices) {
    const found = (device.capabilities ?? []).find((c) => c.capabilityId === TIME_OFFSET_CAP);
    const seconds = Number.parseInt(found?.value, 10);
    if (Number.isInteger(seconds)) return seconds;
  }
  return 0;
}

/**
 * Pièces climatisées du logement : les unités qui portent un mode (capacité 7).
 * @param {object} setup  premier élément de la réponse setupviewv2
 * @param {number} [now]  instant de référence (prochain changement du programme)
 */
export function readRooms(setup, now = Date.now()) {
  const devices = setup?.devices ?? [];
  const zones = new Map((setup?.zones ?? []).map((z) => [z.id, z.name]));
  const context = { now, offsetSeconds: timeOffset(devices) };
  return devices
    .filter((device) => (device.capabilities ?? []).some((c) => c.capabilityId === CAP.mode))
    .map((device) => readOne(device, zones, context));
}

const write = (capabilityId, value) => ({ capabilityId, value: String(value) });

function requireBoolean(value) {
  if (typeof value !== "boolean") throw new CommandError("INVALID_VALUE", "Valeur attendue : oui ou non.");
}

/**
 * Traduit une demande en écritures de capacités, dans l'ordre où les envoyer.
 * Lève une CommandError si la demande n'est pas acceptable pour cette unité.
 *
 * @param {ReturnType<typeof readRooms>[number]} room  état actuel de la pièce
 * @param {string} setting  mode | setpoint | fan | louver | powerful | economy | program | schedule
 * @param {unknown} value
 * @returns {{ capabilityId: number, value: string }[]}
 */
export function planCommand(room, setting, value) {
  if (!room.available) {
    throw new CommandError("UNAVAILABLE", `${room.name} est hors ligne : commande impossible.`);
  }
  const has = (id) => room[CAPS]?.has(id) ?? false;

  switch (setting) {
    case "mode": {
      const entry = MODES.find((m) => m.name === value);
      if (!entry || !room.modes.includes(value)) {
        throw new CommandError("INVALID_VALUE", "Ce mode n'est pas disponible sur cette unité.");
      }
      return [write(CAP.mode, entry.value)];
    }

    case "setpoint": {
      const range = room.setpointRange;
      if (!range || room.mode === "off" || room.mode === "fan") {
        throw new CommandError("INVALID_STATE", "La consigne ne se règle que lorsque l'unité chauffe ou refroidit.");
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new CommandError("INVALID_VALUE", "Consigne invalide.");
      }
      const steps = (value - range.min) / range.step;
      if (value < range.min || value > range.max || Math.abs(steps - Math.round(steps)) > 1e-9) {
        throw new CommandError(
          "INVALID_VALUE",
          `Consigne attendue entre ${range.min} et ${range.max} °C, par pas de ${range.step}.`,
        );
      }
      const target = room.mode === "cool" || room.mode === "dry" ? CAP.coolSetpoint : CAP.heatSetpoint;
      // Programme actif : dérogation jusqu'au prochain créneau, sinon le programme
      // reprendrait aussitôt la main.
      return [...overrideWrites(room.program, has), write(target, value)];
    }

    case "program": {
      if (!room.program?.available) {
        throw new CommandError("UNKNOWN_SETTING", "Programme indisponible sur cette unité.");
      }
      requireBoolean(value);
      return [write(PROGRAM_CAP.mode, value ? "1" : "0")];
    }

    case "schedule":
      return planSchedule(room.program, value, room.program?.ranges ?? {});

    case "fan": {
      if (!room.fanSpeeds?.includes(value)) {
        throw new CommandError("INVALID_VALUE", "Cette vitesse n'est pas disponible sur cette unité.");
      }
      if (value === "quiet") return [write(CAP.quiet, "1")];
      const writes = [];
      if (room.fan === "quiet") writes.push(write(CAP.quiet, "0"));
      writes.push(write(CAP.fanSpeed, FAN_VALUES[value]));
      return writes;
    }

    case "louver": {
      if (!room.louvers?.includes(value)) {
        throw new CommandError("INVALID_VALUE", "Cette position de volet n'est pas disponible.");
      }
      if (value === "swing") return [write(CAP.swing, "1")];
      const writes = [];
      if (room.louver === "swing") writes.push(write(CAP.swing, "0"));
      writes.push(write(CAP.louver, value));
      return writes;
    }

    case "powerful":
    case "economy": {
      if (room[setting] === undefined) {
        throw new CommandError("UNKNOWN_SETTING", "Ce réglage n'existe pas sur cette unité.");
      }
      requireBoolean(value);
      return [write(CAP[setting], value ? "1" : "0")];
    }

    default:
      throw new CommandError("UNKNOWN_SETTING", "Réglage inconnu.");
  }
}
