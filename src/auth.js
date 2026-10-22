/**
 * Contrôle d'accès à l'application.
 *
 * Chaque personne a sa propre clé d'accès, déclarée dans le secret Cloudflare
 * ACCESS_KEYS sous la forme :
 *
 *     Prénom1:clé1, Prénom2:clé2
 *
 * (séparateurs acceptés : virgule ou retour à la ligne). Retirer une entrée
 * suffit à couper l'accès d'une personne sans toucher aux autres.
 *
 * Le téléphone n'envoie sa clé qu'une fois, à la connexion. Le relais la place
 * ensuite dans un cookie « HttpOnly » : le code de la page ne peut pas la lire,
 * donc une faille d'affichage ne permettrait pas de la voler.
 */

/** Une clé : 24 à 256 caractères parmi lettres, chiffres, « - » et « _ ». */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{24,256}$/;

export const SESSION_COOKIE = "cocon_key";

/** Durée de validité du cookie : 180 jours, puis nouvelle saisie de la clé. */
const SESSION_MAX_AGE_S = 180 * 24 * 3600;

/**
 * Lit le secret ACCESS_KEYS.
 * @returns {{ name: string, key: string }[]} entrées valides uniquement
 */
export function parseAccessKeys(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0) return null;
      const name = entry.slice(0, separator).trim();
      const key = entry.slice(separator + 1).trim();
      return name && KEY_PATTERN.test(key) ? { name, key } : null;
    })
    .filter(Boolean);
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Comparaison en temps constant de deux empreintes de même longueur. */
function sameDigest(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Cherche à qui appartient une clé.
 *
 * @returns {Promise<{ ok: true, name: string } | { ok: false, reason: "CONFIG" | "UNAUTHORIZED" }>}
 */
export async function matchKey(given, env) {
  const entries = parseAccessKeys(env.ACCESS_KEYS);
  if (entries.length === 0) return { ok: false, reason: "CONFIG" };
  if (typeof given !== "string" || !KEY_PATTERN.test(given)) {
    return { ok: false, reason: "UNAUTHORIZED" };
  }

  // On compare des empreintes SHA-256 (longueur fixe) plutôt que les clés
  // elles-mêmes, et on parcourt toutes les entrées, pour ne rien laisser
  // deviner par le temps de réponse.
  const digest = await sha256(given);
  let found = null;
  for (const entry of entries) {
    if (sameDigest(digest, await sha256(entry.key)) && !found) found = entry;
  }
  return found ? { ok: true, name: found.name } : { ok: false, reason: "UNAUTHORIZED" };
}

/** Valeur d'un cookie de la requête, ou null. */
export function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

/** Identifie la personne à partir de son cookie de session. */
export function identify(request, env) {
  return matchKey(readCookie(request, SESSION_COOKIE), env);
}

/** En-tête Set-Cookie qui ouvre la session (clé déjà validée). */
export function sessionCookie(key) {
  return `${SESSION_COOKIE}=${key}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_S}`;
}

/** En-tête Set-Cookie qui ferme la session. */
export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
