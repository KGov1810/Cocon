/**
 * Rapport de diagnostic : ce que le compte Atlantic expose réellement.
 *
 * Lecture seule — aucune commande n'est envoyée aux unités. Le rapport sert à
 * découvrir les capacités de chaque unité avant de construire l'interface, et
 * peut être copié pour être partagé : les champs qui identifient le matériel
 * ou la personne (numéros de série, adresses…) y sont masqués.
 */

import { AtlanticError } from "./atlantic.js";

/** Capacité qui déclare les consommations suivies par le logement. */
export const CONSUMPTION_CAPABILITY = 164;

/** Bits 1 à 64 de la capacité 164 : compteurs (gaz, électricité, fioul…). */
const CONSUMPTION_METER_BITS = 127;

/**
 * Champs masqués dans le rapport, quel que soit leur niveau.
 * Liste d'exclusion volontairement large : le diagnostic doit montrer les
 * champs inconnus d'Atlantic, on ne peut donc pas se limiter à une liste blanche.
 */
const SENSITIVE_KEY =
  /serial|mac|address|url|email|owner|phone|latitude|longitude|gps|location|city|zip|postal|street|ssid|wifi|token|password|secret/i;

/** Champs du logement conservés (tout le reste est ignoré). */
const SETUP_FIELDS = ["id", "name", "type", "rateLimit", "numberOfRooms", "zones"];

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SENSITIVE_KEY.test(key) && inner !== null ? "[masqué]" : redact(inner),
      ]),
    );
  }
  return value;
}

/** Nom lisible d'une capacité d'après le catalogue Atlantic, s'il existe. */
function labelOf(row) {
  return row?.name ?? row?.label ?? row?.displayName ?? null;
}

/** Valeurs de la capacité 164 trouvées sur les unités, en entiers. */
function consumptionMasks(devices) {
  const masks = [];
  for (const device of devices) {
    for (const capability of device.capabilities ?? []) {
      if (capability.capabilityId !== CONSUMPTION_CAPABILITY) continue;
      const mask = Number.parseInt(String(capability.value).trim(), 10);
      if (Number.isInteger(mask)) masks.push(mask);
    }
  }
  return masks;
}

/**
 * Exécute une lecture facultative : son échec est noté dans le rapport au lieu
 * de faire échouer tout le diagnostic.
 */
async function optional(read) {
  try {
    return { value: await read() };
  } catch (err) {
    if (!(err instanceof AtlanticError)) throw err;
    return { error: { code: err.code, message: err.message } };
  }
}

/**
 * @param {ReturnType<import("./atlantic.js").createAtlanticClient>} client
 * @param {() => number} [now]
 */
export async function buildDiagnostic(client, now = Date.now) {
  const setup = await client.getSetup();
  const devices = Array.isArray(setup.devices) ? setup.devices : [];

  const [catalogueRead, consumptionRead] = await Promise.all([
    optional(() => client.getCapabilityCatalogue()),
    setup.id != null
      ? optional(() => client.getDailyConsumption(setup.id))
      : Promise.resolve({ value: { status: null, body: null } }),
  ]);

  const usedIds = new Set(
    devices.flatMap((device) => (device.capabilities ?? []).map((c) => c.capabilityId)),
  );
  const catalogue = {};
  for (const row of catalogueRead.value ?? []) {
    if (row && usedIds.has(row.id)) catalogue[row.id] = row;
  }

  const masks = consumptionMasks(devices);
  const consumption = consumptionRead.value ?? { status: null, body: null };
  const answer = consumption.body;

  return {
    version: 1,
    generatedAt: new Date(now()).toISOString(),
    account: redact(
      Object.fromEntries(SETUP_FIELDS.filter((k) => k in setup).map((k) => [k, setup[k]])),
    ),
    devices: devices.map((device) => {
      const { capabilities = [], ...rest } = device;
      return {
        ...redact(rest),
        capabilities: capabilities
          .map((capability) => ({
            ...redact(capability),
            label: labelOf(catalogue[capability.capabilityId]),
          }))
          .sort((a, b) => a.capabilityId - b.capabilityId),
      };
    }),
    catalogue: redact(catalogue),
    catalogueError: catalogueRead.error ?? null,
    consumption: {
      // null : aucune unité ne publie la capacité 164 ; la route tranche seule.
      declared: masks.length ? masks.some((m) => (m & CONSUMPTION_METER_BITS) !== 0) : null,
      masks,
      status: consumption.status,
      available: consumption.status === 200 && Array.isArray(answer) && answer.length > 0,
      error: consumptionRead.error ?? null,
      answer: redact(answer),
    },
    timings: client.timings,
  };
}
