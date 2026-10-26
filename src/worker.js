/**
 * Point d'entrée du Worker Cloudflare « Cocon ».
 *
 * - /api/*  : l'API de l'application (accès réservé aux clés déclarées).
 * - le reste : les fichiers de l'application (dossier public/), servis
 *              directement par Cloudflare.
 *
 * Les identifiants Cozytouch ne quittent jamais ce Worker : le téléphone ne
 * connaît que sa clé d'accès personnelle.
 */

import { AtlanticError, createAtlanticClient } from "./atlantic.js";
import { clearedSessionCookie, identify, matchKey, sessionCookie } from "./auth.js";
import { readState, runAbsence, runCommand } from "./commands.js";
import { buildDiagnostic } from "./diagnostic.js";
import { CommandError } from "./errors.js";

/** Code HTTP renvoyé pour chaque refus de commande. */
const COMMAND_ERROR_STATUS = {
  ROOM_NOT_FOUND: 404,
  COMMAND_REFUSED: 502,
  COMMAND_FAILED: 502,
};

/** /api/rooms/<identifiant numérique de la pièce> */
const ROOM_ROUTE = /^\/api\/rooms\/(\d{1,12})$/;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Taille maximale d'un corps de requête accepté (la connexion n'a besoin que de la clé). */
const MAX_BODY_BYTES = 1024;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function apiError(status, code, message, extraHeaders) {
  return json({ error: { code, message } }, status, extraHeaders);
}

const CONFIG_MISSING = () =>
  apiError(
    503,
    "CONFIG",
    "Aucune clé d'accès valide n'est configurée dans Cloudflare (secret ACCESS_KEYS).",
  );

/** Traduit une erreur Atlantic en réponse HTTP pour l'application. */
function fromAtlanticError(err) {
  switch (err.code) {
    case "CONFIG":
    case "AUTH_REFUSED":
      return apiError(503, err.code, err.message);
    case "RATE_LIMITED":
      return apiError(429, err.code, err.message, { "Retry-After": String(err.retryAfter) });
    case "TIMEOUT":
      return apiError(504, err.code, err.message);
    default:
      return apiError(502, "UPSTREAM", err.message);
  }
}

/**
 * Lit un petit corps JSON ; null s'il est trop gros ou illisible. La lecture
 * s'arrête dès que la limite est dépassée : un corps énorme n'est jamais chargé.
 */
async function readSmallJson(request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(read.value);
  }
  try {
    return JSON.parse(await new Blob(chunks).text());
  } catch {
    return null;
  }
}

/** POST /api/session : vérifie la clé et ouvre la session (cookie HttpOnly). */
async function openSession(request, env) {
  const body = await readSmallJson(request);
  if (!body || typeof body.key !== "string") {
    return apiError(400, "BAD_REQUEST", "Requête de connexion invalide.");
  }
  const key = body.key.trim();
  const who = await matchKey(key, env);
  if (!who.ok) {
    return who.reason === "CONFIG"
      ? CONFIG_MISSING()
      : apiError(401, "UNAUTHORIZED", "Cette clé n'est pas reconnue.");
  }
  return json({ name: who.name }, 200, { "Set-Cookie": sessionCookie(key) });
}

/**
 * @param {Request} request
 * @param {object} env  secrets et liaisons du Worker
 * @param {object} [deps]  dépendances remplaçables dans les tests
 */
export async function handleApi(request, env, deps = {}) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;

  // Toute requête qui modifie quelque chose doit venir de l'application
  // elle-même (protection contre les requêtes envoyées par un autre site).
  if (request.method !== "GET" && request.headers.get("Origin") !== url.origin) {
    return apiError(403, "FORBIDDEN_ORIGIN", "Requête refusée : origine inconnue.");
  }

  try {
    if (route === "POST /api/session") return await openSession(request, env);
    if (route === "DELETE /api/session") {
      return json({ ok: true }, 200, { "Set-Cookie": clearedSessionCookie() });
    }

    const who = await identify(request, env);
    if (!who.ok) {
      return who.reason === "CONFIG"
        ? CONFIG_MISSING()
        : apiError(401, "UNAUTHORIZED", "Session absente ou expirée : reconnectez-vous.");
    }

    if (route === "GET /api/me") return json({ name: who.name });

    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? defaultSleep;
    const client = createAtlanticClient(env, deps); // aucun appel réseau avant la première requête

    if (route === "GET /api/state") return json(await readState(client, env, now));

    const roomMatch = request.method === "POST" && url.pathname.match(ROOM_ROUTE);
    if (roomMatch) {
      const body = await readSmallJson(request);
      if (typeof body?.setting !== "string") {
        return apiError(400, "BAD_REQUEST", "Commande invalide.");
      }
      const result = await runCommand(
        client,
        env,
        { roomId: Number(roomMatch[1]), setting: body.setting, value: body.value },
        { now, sleep },
      );
      console.log("Commande", who.name, roomMatch[1], body.setting, result.status, `${result.elapsedMs} ms`);
      return json(result, result.status === "confirmed" ? 200 : 202);
    }

    if (route === "POST /api/absence" || route === "DELETE /api/absence") {
      let window = null; // DELETE : annuler l'absence
      if (request.method === "POST") {
        window = await readSmallJson(request);
        if (!window || typeof window !== "object") return apiError(400, "BAD_REQUEST", "Absence invalide.");
      }
      const result = await runAbsence(client, env, window, { now, sleep });
      console.log("Absence", who.name, window ? "programmée" : "annulée", result.status, `${result.elapsedMs} ms`);
      return json(result, result.status === "confirmed" ? 200 : 202);
    }

    if (route === "GET /api/diagnostic") return json(await buildDiagnostic(client, now));

    return apiError(404, "NOT_FOUND", "Route inconnue.");
  } catch (err) {
    if (err instanceof CommandError) {
      return apiError(COMMAND_ERROR_STATUS[err.code] ?? 422, err.code, err.message);
    }
    if (err instanceof AtlanticError) return fromAtlanticError(err);
    console.error("Erreur inattendue", err?.name, err?.message);
    return apiError(500, "INTERNAL", "Erreur interne du relais.");
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return handleApi(request, env);
    // Fichiers de l'application ; une adresse inconnue renvoie la 404 de Cloudflare.
    return env.ASSETS.fetch(request);
  },
};
