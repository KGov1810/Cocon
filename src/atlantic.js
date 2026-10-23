/**
 * Client minimal pour le cloud Atlantic « Magellan » (apis.groupe-atlantic.com).
 *
 * C'est l'API qu'utilise l'application Cozytouch pour les climatiseurs Takao
 * reliés au Hub Cozytouch. Elle n'est ni documentée ni officielle : les routes
 * ci-dessous viennent de la documentation publique du projet open source
 * gduteil/cozytouch (intégration Home Assistant). Aucun code n'en est copié.
 *
 * Ce module ne fait que des appels réseau et ne connaît rien de l'interface :
 * il renvoie les réponses d'Atlantic telles quelles, ou lève une AtlanticError
 * avec un code exploitable par l'application.
 */

export const DEFAULT_API = "https://apis.groupe-atlantic.com";

/** Délai maximal d'une requête vers Atlantic, en millisecondes. */
const REQUEST_TIMEOUT_MS = 15000;

/** Marge prise avant l'expiration du jeton, pour ne jamais l'utiliser périmé. */
const TOKEN_MARGIN_MS = 60_000;

export class AtlanticError extends Error {
  /**
   * @param {string} code  CONFIG | AUTH_REFUSED | RATE_LIMITED | TIMEOUT | UPSTREAM
   * @param {string} message  Message en français, affichable tel quel.
   * @param {object} [extra]  { status, retryAfter }
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "AtlanticError";
    this.code = code;
    this.status = extra.status;
    this.retryAfter = extra.retryAfter;
  }
}

/*
 * Jeton Atlantic partagé entre les requêtes traitées par une même instance du
 * Worker. Cloudflare peut faire tourner plusieurs instances : au pire, chacune
 * se connecte une fois, ce qui reste négligeable.
 */
let tokenCache = null; // { token, expiresAt, account }

/** Vide le cache du jeton (utilisé par les tests). */
export function resetTokenCache() {
  tokenCache = null;
}

/**
 * Crée un client lié aux secrets du Worker.
 *
 * @param {object} env  Variables du Worker : COZYTOUCH_EMAIL, COZYTOUCH_PASSWORD,
 *                      COZYTOUCH_CLIENT_ID, et ATLANTIC_API (facultatif, pour les essais).
 * @param {object} [deps]  { fetchImpl, now } remplaçables dans les tests.
 */
export function createAtlanticClient(env, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));
  const now = deps.now ?? Date.now;
  const base = (env.ATLANTIC_API || DEFAULT_API).replace(/\/+$/, "");

  /** Durée de chaque appel, pour la page de diagnostic. */
  const timings = [];

  function requireSecrets() {
    const missing = ["COZYTOUCH_EMAIL", "COZYTOUCH_PASSWORD", "COZYTOUCH_CLIENT_ID"].filter(
      (name) => !env[name],
    );
    if (missing.length) {
      throw new AtlanticError(
        "CONFIG",
        `Secrets manquants dans Cloudflare : ${missing.join(", ")}.`,
      );
    }
  }

  /** Lance une requête avec délai maximal et mesure sa durée. */
  async function timedFetch(label, url, init) {
    const started = now();
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      timings.push({ step: label, ms: now() - started, status: response.status });
      return response;
    } catch (err) {
      timings.push({ step: label, ms: now() - started, status: null });
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new AtlanticError("TIMEOUT", "Le cloud Atlantic ne répond pas (délai dépassé).");
      }
      throw new AtlanticError("UPSTREAM", "Impossible de joindre le cloud Atlantic.");
    }
  }

  /** Connexion « mot de passe » OAuth2, comme l'application Cozytouch. */
  async function login() {
    requireSecrets();
    const body = new URLSearchParams({
      grant_type: "password",
      scope: "openid",
      username: `GA-PRIVATEPERSON/${env.COZYTOUCH_EMAIL}`,
      password: env.COZYTOUCH_PASSWORD,
    });
    const response = await timedFetch("connexion", `${base}/users/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${env.COZYTOUCH_CLIENT_ID}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    checkRateLimit(response);

    const data = await response.json().catch(() => null);
    if (data?.error === "invalid_grant") {
      throw new AtlanticError(
        "AUTH_REFUSED",
        "Atlantic refuse l'e-mail ou le mot de passe Cozytouch enregistré dans Cloudflare.",
        { status: response.status },
      );
    }
    if (!response.ok || !data?.access_token) {
      throw new AtlanticError(
        "UPSTREAM",
        `Connexion à Atlantic impossible (HTTP ${response.status}).`,
        { status: response.status },
      );
    }

    const lifetimeMs = (Number(data.expires_in) || 3600) * 1000;
    tokenCache = {
      token: data.access_token,
      expiresAt: now() + lifetimeMs - TOKEN_MARGIN_MS,
      account: env.COZYTOUCH_EMAIL,
    };
    return tokenCache.token;
  }

  /** Jeton valide : celui en cache s'il est encore bon, sinon un nouveau. */
  async function token({ force = false } = {}) {
    const usable =
      tokenCache &&
      tokenCache.account === env.COZYTOUCH_EMAIL &&
      tokenCache.expiresAt > now();
    if (usable && !force) return tokenCache.token;
    return login();
  }

  function checkRateLimit(response) {
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After")) || 60;
      throw new AtlanticError(
        "RATE_LIMITED",
        `Trop de requêtes vers Atlantic. Réessayez dans ${retryAfter} s.`,
        { status: 429, retryAfter },
      );
    }
  }

  /**
   * Requête authentifiée (GET, ou POST JSON si `json` est fourni, ou la méthode
   * indiquée). Si Atlantic rejette le jeton (401), on se reconnecte une seule
   * fois puis on réessaie.
   * @returns {Promise<{ status: number, body: unknown }>}
   */
  async function authed(label, path, json, method = json === undefined ? "GET" : "POST") {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bearer = await token({ force: attempt > 0 });
      const response = await timedFetch(label, `${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(json === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      checkRateLimit(response);
      if (response.status === 401) {
        if (attempt === 0) continue;
        throw new AtlanticError("UPSTREAM", "Atlantic refuse le jeton de connexion.", {
          status: 401,
        });
      }
      return {
        status: response.status,
        body: response.ok ? await response.json().catch(() => null) : null,
      };
    }
    // Inaccessible : la boucle renvoie ou lève toujours une erreur.
    throw new AtlanticError("UPSTREAM", "Atlantic refuse le jeton de connexion.");
  }

  return {
    timings,

    /** Vue complète du logement : unités, pièces et leurs capacités. */
    async getSetup() {
      const { status, body } = await authed("logement", "/magellan/cozytouch/setupviewv2");
      if (status !== 200 || !Array.isArray(body) || body.length === 0) {
        throw new AtlanticError(
          "UPSTREAM",
          `Réponse inattendue d'Atlantic pour le logement (HTTP ${status}).`,
          { status },
        );
      }
      return body[0];
    },

    /** Catalogue des capacités (nom, type, bornes) publié par Atlantic. */
    async getCapabilityCatalogue() {
      const { status, body } = await authed("catalogue", "/magellan/productmodels/capabilities");
      return status === 200 && Array.isArray(body) ? body : [];
    },

    /** Consommation journalière du logement ; la réponse brute est renvoyée. */
    async getDailyConsumption(setupId) {
      return authed(
        "consommation",
        `/magellan/setups/${encodeURIComponent(setupId)}/consumptions?periodicity=daily`,
      );
    },

    /**
     * Demande l'écriture d'une capacité. Atlantic répond 201 avec l'identifiant
     * de l'« exécution », dont on suit ensuite l'avancement.
     * @returns {Promise<{ status: number, executionId: string | null }>}
     */
    async writeCapability(deviceId, capabilityId, value) {
      const { status, body } = await authed("écriture", "/magellan/executions/writecapability", {
        capabilityId,
        deviceId,
        value,
      });
      const id = typeof body === "number" || typeof body === "string" ? String(body) : null;
      return { status, executionId: status === 201 && id && /^\d+$/.test(id) ? id : null };
    },

    /**
     * Remplace les champs modifiables du logement (utilisé pour l'absence).
     * @returns {Promise<{ status: number }>}
     */
    async putSetup(setupId, body) {
      const { status } = await authed("logement (écriture)", `/magellan/v2/setups/${encodeURIComponent(setupId)}`, body, "PUT");
      return { status };
    },

    /**
     * État d'une exécution : 1 en attente, 2 en cours, 3 terminée, autre = échec.
     * @returns {Promise<number | null>} null si la réponse est illisible
     */
    async getExecutionState(executionId) {
      const { status, body } = await authed("suivi", `/magellan/executions/${executionId}`);
      const state = status === 200 ? Number(body?.state) : Number.NaN;
      return Number.isInteger(state) ? state : null;
    },
  };
}
