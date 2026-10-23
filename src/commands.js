/**
 * Lecture de l'état des pièces et exécution des commandes.
 *
 * Une commande se déroule ainsi :
 *   1. on lit l'état de la pièce (cache récent, sinon Atlantic) ;
 *   2. planCommand() la valide et la traduit en écritures de capacités ;
 *   3. chaque écriture est envoyée, puis on suit son « exécution » côté Atlantic
 *      jusqu'à confirmation, refus, ou expiration du délai d'attente.
 */

import { absenceDevice, ABSENCE_CAP, planAbsence, readAbsence, setupBody, windowValue } from "./absence.js";
import { CommandError, planCommand, readRooms } from "./rooms.js";

/** Âge maximal de l'état en cache pour valider une commande. */
const SETUP_MAX_AGE_MS = 60_000;

/** Attentes successives avant chaque lecture d'une exécution (≈ 9 s au total). */
const EXECUTION_POLL_DELAYS_MS = [600, 900, 1200, 1500, 2000, 2500];

const EXECUTION_WAITING = 1;
const EXECUTION_RUNNING = 2;
const EXECUTION_DONE = 3;

/*
 * Dernier état lu, partagé entre les requêtes d'une même instance du Worker :
 * il évite une lecture complète (≈ 2 s) avant chaque commande.
 */
let setupCache = null; // { at, account, setup }

/** Vide le cache (utilisé par les tests). */
export function resetSetupCache() {
  setupCache = null;
}

async function loadSetup(client, env, now, maxAgeMs) {
  const fresh =
    setupCache &&
    setupCache.account === env.COZYTOUCH_EMAIL &&
    now() - setupCache.at <= maxAgeMs;
  if (fresh) return setupCache.setup;
  const setup = await client.getSetup();
  setupCache = { at: now(), account: env.COZYTOUCH_EMAIL, setup };
  return setup;
}

/** État complet des pièces, toujours relu chez Atlantic. */
export async function readState(client, env, now) {
  const setup = await loadSetup(client, env, now, 0);
  return {
    rooms: readRooms(setup, now()),
    absence: readAbsence(setup),
    updatedAt: new Date(now()).toISOString(),
  };
}

/** Suit une exécution : "confirmed", "pending" (délai dépassé) ou "failed". */
async function waitForExecution(client, executionId, sleep) {
  for (const delay of EXECUTION_POLL_DELAYS_MS) {
    await sleep(delay);
    const state = await client.getExecutionState(executionId);
    if (state === EXECUTION_DONE) return "confirmed";
    if (state === null || state === EXECUTION_WAITING || state === EXECUTION_RUNNING) continue;
    return "failed";
  }
  return "pending";
}

/** Lecture unique de l'état d'une exécution déjà en cours. */
async function checkExecution(client, executionId) {
  const state = await client.getExecutionState(executionId);
  if (state === EXECUTION_DONE) return "confirmed";
  if (state === null || state === EXECUTION_WAITING || state === EXECUTION_RUNNING) return "pending";
  return "failed";
}

async function send(client, roomId, { capabilityId, value }) {
  const { status, executionId } = await client.writeCapability(roomId, capabilityId, value);
  if (!executionId) {
    throw new CommandError("COMMAND_REFUSED", `Atlantic a refusé la commande (HTTP ${status}).`);
  }
  return executionId;
}

/**
 * Écritures dépendantes (ex. durée de dérogation, puis dérogation, puis
 * consigne) : chacune attend la confirmation de la précédente.
 */
async function runInOrder(client, roomId, writes, sleep) {
  const outcomes = [];
  for (const write of writes) {
    const outcome = await waitForExecution(client, await send(client, roomId, write), sleep);
    if (outcome === "failed") return ["failed"];
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Écritures indépendantes (un jour de programme par écriture) : on envoie tout,
 * on suit la dernière jusqu'au bout, puis on vérifie les autres une seule fois.
 * Suivre chaque jour séparément dépasserait vite le quota d'Atlantic (≈ 30 req/min).
 */
async function runAsBatch(client, roomId, writes, sleep) {
  const executions = [];
  for (const write of writes) executions.push(await send(client, roomId, write));
  const last = await waitForExecution(client, executions.at(-1), sleep);
  const others = [];
  for (const executionId of executions.slice(0, -1)) others.push(await checkExecution(client, executionId));
  return [...others, last];
}

/**
 * Valide puis exécute une commande sur une pièce.
 * @returns {Promise<{ status: "confirmed" | "pending", elapsedMs: number }>}
 * @throws {CommandError} demande invalide, pièce inconnue, ou refus d'Atlantic
 */
export async function runCommand(client, env, { roomId, setting, value }, { now, sleep }) {
  const started = now();
  const setup = await loadSetup(client, env, now, SETUP_MAX_AGE_MS);
  const room = readRooms(setup, now()).find((r) => r.id === roomId);
  if (!room) throw new CommandError("ROOM_NOT_FOUND", "Pièce introuvable.");

  const writes = planCommand(room, setting, value);
  let outcomes;
  try {
    outcomes =
      setting === "schedule"
        ? await runAsBatch(client, roomId, writes, sleep)
        : await runInOrder(client, roomId, writes, sleep);
  } finally {
    // L'état a (peut-être) changé : la prochaine lecture doit venir d'Atlantic.
    setupCache = null;
  }
  if (outcomes.includes("failed")) {
    throw new CommandError("COMMAND_FAILED", "L'unité n'a pas pu appliquer la commande.");
  }
  return { status: outcomes.includes("pending") ? "pending" : "confirmed", elapsedMs: now() - started };
}

/**
 * Programme ou annule l'absence de tout le logement.
 * @param {{ start: number, end: number } | null} request  null pour annuler
 */
export async function runAbsence(client, env, request, { now, sleep }) {
  const started = now();
  const window = request === null ? null : planAbsence(request, now());
  const setup = await loadSetup(client, env, now, SETUP_MAX_AGE_MS);
  const hub = absenceDevice(setup);
  if (!hub) throw new CommandError("UNKNOWN_SETTING", "Ce logement ne propose pas de mode Absence.");

  let outcome;
  try {
    const { status } = await client.putSetup(setup.id, setupBody(setup, window));
    if (status < 200 || status >= 300) {
      throw new CommandError("COMMAND_REFUSED", `Atlantic a refusé l'absence (HTTP ${status}).`);
    }
    // Le logement a pris la fenêtre ; on la recopie sur le hub, comme l'appli
    // Cozytouch. Un refus du hub n'annule pas l'absence : elle reste « en attente ».
    const { executionId } = await client.writeCapability(hub.deviceId, ABSENCE_CAP.window, windowValue(window));
    outcome = executionId ? await waitForExecution(client, executionId, sleep) : "pending";
  } finally {
    setupCache = null;
  }
  return { status: outcome === "confirmed" ? "confirmed" : "pending", elapsedMs: now() - started };
}
