/**
 * Mode Absence : il vaut pour tout le logement. Pendant une absence, les
 * climatiseurs s'arrêtent, puis reprennent leur mode au retour.
 *
 * L'état se lit sur le hub (capacité 152 : 0 désactivée, 1 en cours,
 * 2 programmée ; capacité 222 : « [début,fin] » en secondes Unix).
 * L'écriture passe par le logement lui-même (PUT /magellan/v2/setups/<id>),
 * comme l'application Cozytouch, puis la fenêtre est recopiée sur le hub.
 */

import { CommandError } from "./errors.js";

export const ABSENCE_CAP = { status: 152, window: 222 };

const STATUS = { 0: "off", 1: "on", 2: "scheduled" };

/** Champs du logement que l'API accepte en retour, sans autre donnée. */
const SETUP_WRITABLE_FIELDS = [
  "address",
  "area",
  "currency",
  "mainHeatingEnergy",
  "mainDHWEnergy",
  "name",
  "numberOfPersons",
  "numberOfRooms",
  "setupBuildingDate",
  "type",
];

const MIN_DURATION_S = 15 * 60;
const MAX_AHEAD_S = 366 * 86400;
const CLOCK_SKEW_S = 5 * 60;

/** Appareil qui porte la fenêtre d'absence (le hub), ou undefined. */
export function absenceDevice(setup) {
  return (setup?.devices ?? []).find((d) => (d.capabilities ?? []).some((c) => c.capabilityId === ABSENCE_CAP.window));
}

function parseWindow(raw) {
  try {
    const pair = JSON.parse(raw);
    if (Array.isArray(pair) && pair.length === 2 && pair.every((n) => Number.isInteger(n) && n > 0)) return pair;
  } catch {
    /* fenêtre illisible : considérée comme absente */
  }
  return null;
}

/** État de l'absence pour l'application. */
export function readAbsence(setup) {
  const hub = absenceDevice(setup);
  if (!hub) return { available: false, status: "off", start: null, end: null };
  const caps = new Map(hub.capabilities.map((c) => [c.capabilityId, c.value]));
  const window = parseWindow(caps.get(ABSENCE_CAP.window));
  return {
    available: true,
    status: STATUS[String(caps.get(ABSENCE_CAP.status))] ?? "off",
    start: window?.[0] ?? null,
    end: window?.[1] ?? null,
  };
}

/**
 * Valide une fenêtre d'absence demandée par l'application (secondes Unix).
 * @returns {{ start: number, end: number }}
 */
export function planAbsence(value, nowMs) {
  const nowS = Math.floor(nowMs / 1000);
  const { start, end } = value ?? {};
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new CommandError("INVALID_VALUE", "Dates de départ et de retour invalides.");
  }
  if (start < nowS - CLOCK_SKEW_S) throw new CommandError("INVALID_VALUE", "Le départ est déjà passé.");
  if (end - start < MIN_DURATION_S) {
    throw new CommandError("INVALID_VALUE", "Le retour doit suivre le départ d'au moins 15 minutes.");
  }
  if (end > nowS + MAX_AHEAD_S) throw new CommandError("INVALID_VALUE", "Le retour doit être dans moins d'un an.");
  return { start, end };
}

/** Corps du PUT : les champs modifiables du logement, et l'absence (vide pour l'annuler). */
export function setupBody(setup, window) {
  const body = {};
  for (const field of SETUP_WRITABLE_FIELDS) if (field in setup) body[field] = setup[field];
  body.absence = window ? { startDate: window.start, endDate: window.end } : {};
  return body;
}

/** Valeur de la capacité 222 pour une fenêtre (ou son effacement). */
export function windowValue(window) {
  return window ? `[${window.start},${window.end}]` : "[0,0]";
}
