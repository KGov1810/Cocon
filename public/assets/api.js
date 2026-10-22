/**
 * Accès à l'API Cocon depuis le téléphone.
 *
 * La clé d'accès n'est envoyée qu'une fois, à la connexion. Le relais renvoie
 * un cookie de session « HttpOnly » que le navigateur joint ensuite tout seul à
 * chaque appel : le code de la page ne voit ni ne stocke jamais la clé.
 */

/** Erreur renvoyée par l'API, avec un message prêt à afficher. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Appel de l'API Cocon.
 * @param {string} method  "GET", "POST" ou "DELETE"
 * @param {string} path    ex. "/api/diagnostic"
 * @param {object} [body]  corps JSON facultatif
 */
export async function api(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "OFFLINE", "Pas de connexion internet, ou le relais est injoignable.");
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error?.code ?? "UNKNOWN",
      data?.error?.message ?? `Erreur inattendue (HTTP ${response.status}).`,
    );
  }
  return data;
}

/** Clé aléatoire de 32 caractères (lettres, chiffres, - et _). */
export function generateAccessKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Petit utilitaire DOM : crée un élément sans jamais interpréter de HTML. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (name === "class") node.className = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Copie un texte ; renvoie false si le navigateur refuse. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
