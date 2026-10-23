/**
 * Lecture de l'état des pièces et exécution des commandes.
 *
 * Une commande se déroule ainsi :
 *   1. on lit l'état de la pièce (cache récent, sinon Atlantic) ;
 *   2. planCommand() la valide et la traduit en écritures de capacités ;
 *   3. chaque écriture est envoyée, puis on suit son « exécution » côté Atlantic
 *      jusqu'à confirmation, refus, ou expiration du délai d'attente.
 */

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
  return { rooms: readRooms(setup), updatedAt: new Date(now()).toISOString() };
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

/**
 * Valide puis exécute une commande sur une pièce.
 * @returns {Promise<{ status: "confirmed" | "pending", elapsedMs: number }>}
 * @throws {CommandError} demande invalide, pièce inconnue, ou refus d'Atlantic
 */
export async function runCommand(client, env, { roomId, setting, value }, { now, sleep }) {
  const started = now();
  const setup = await loadSetup(client, env, now, SETUP_MAX_AGE_MS);
  const room = readRooms(setup).find((r) => r.id === roomId);
  if (!room) throw new CommandError("ROOM_NOT_FOUND", "Pièce introuvable.");

  const writes = planCommand(room, setting, value);
  let pending = false;
  try {
    for (const { capabilityId, value: raw } of writes) {
      const { status, executionId } = await client.writeCapability(roomId, capabilityId, raw);
      if (!executionId) {
        throw new CommandError("COMMAND_REFUSED", `Atlantic a refusé la commande (HTTP ${status}).`);
      }
      const outcome = await waitForExecution(client, executionId, sleep);
      if (outcome === "failed") {
        throw new CommandError("COMMAND_FAILED", "L'unité n'a pas pu appliquer la commande.");
      }
      if (outcome === "pending") pending = true;
    }
  } finally {
    // L'état a (peut-être) changé : la prochaine lecture doit venir d'Atlantic.
    setupCache = null;
  }
  return { status: pending ? "pending" : "confirmed", elapsedMs: now() - started };
}
