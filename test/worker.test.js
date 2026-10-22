// Tests du relais, sans réseau : un faux « cloud Atlantic » répond à la place
// du vrai. Lancer avec : npm test
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { resetTokenCache } from "../src/atlantic.js";
import { parseAccessKeys } from "../src/auth.js";
import { handleApi } from "../src/worker.js";

const ORIGIN = "https://cocon.test";
const KEY = "cle-de-test-suffisamment-longue";

const ENV = {
  COZYTOUCH_EMAIL: "test@exemple.fr",
  COZYTOUCH_PASSWORD: "secret",
  COZYTOUCH_CLIENT_ID: "Y2xpZW50OnNlY3JldA==",
  ACCESS_KEYS: `Kevin:${KEY}, Proche:autre-cle-tres-longue-aussi`,
  ATLANTIC_API: "https://atlantic.test",
};

const SETUP = [
  {
    id: 4242,
    name: "Maison",
    rateLimit: 30,
    address: "1 rue Secrète",
    zones: [{ id: 1, name: "Salon" }],
    devices: [
      {
        deviceId: 11,
        name: "Salon",
        modelId: 557,
        gatewaySerialNumber: "SN-123",
        location: "Ville-Secrète",
        capabilities: [
          { capabilityId: 7, value: "4" },
          { capabilityId: 164, value: "0" },
        ],
      },
    ],
  },
];

/** Faux cloud Atlantic : enregistre les appels et répond selon `routes`. */
function fakeAtlantic(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    calls.push({ path: pathname + search, init });
    const handler = routes[pathname];
    if (!handler) return new Response("introuvable", { status: 404 });
    const outcome = handler(init, calls);
    if (outcome instanceof Error) throw outcome;
    const [status, body, headers] = outcome;
    return new Response(JSON.stringify(body), { status, headers });
  };
  return { fetchImpl, calls };
}

const defaultRoutes = () => ({
  "/users/token": () => [200, { access_token: "jeton-1", token_type: "bearer", expires_in: 3600 }],
  "/magellan/cozytouch/setupviewv2": () => [200, SETUP],
  "/magellan/productmodels/capabilities": () => [
    200,
    [
      { id: 7, name: "HVAC mode" },
      { id: 999, name: "Inutilisée" },
    ],
  ],
  "/magellan/setups/4242/consumptions": () => [200, []],
});

/** Requête authentifiée par le cookie de session (comme le navigateur). */
function get(path, key = KEY) {
  const headers = key ? { Cookie: `autre=1; cocon_key=${key}` } : {};
  return new Request(`${ORIGIN}${path}`, { headers });
}

function post(path, body, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const timeoutError = () => Object.assign(new Error("délai"), { name: "TimeoutError" });

beforeEach(() => resetTokenCache());

describe("clés d'accès", () => {
  it("lit les entrées valides et écarte les clés trop courtes ou mal formées", () => {
    assert.deepEqual(
      parseAccessKeys(
        "A:courte, B:une-cle-assez-longue-ici-oui\nC:une-autre-cle-assez-longue, D:cle avec espaces et ; point-virgule",
      ),
      [
        { name: "B", key: "une-cle-assez-longue-ici-oui" },
        { name: "C", key: "une-autre-cle-assez-longue" },
      ],
    );
  });

  it("refuse une requête sans session", async () => {
    const res = await handleApi(get("/api/me", null), ENV);
    assert.equal(res.status, 401);
  });

  it("refuse une session portant une mauvaise clé", async () => {
    const res = await handleApi(get("/api/me", "mauvaise-cle-mais-assez-longue"), ENV);
    assert.equal(res.status, 401);
  });

  it("refuse une clé envoyée dans l'en-tête Authorization (ancienne méthode)", async () => {
    const req = new Request(`${ORIGIN}/api/me`, { headers: { Authorization: `Bearer ${KEY}` } });
    assert.equal((await handleApi(req, ENV)).status, 401);
  });

  it("reconnaît la personne", async () => {
    const res = await handleApi(get("/api/me"), ENV);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: "Kevin" });
  });

  it("signale une configuration absente", async () => {
    const res = await handleApi(get("/api/me"), { ...ENV, ACCESS_KEYS: "" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "CONFIG");
  });
});

describe("session", () => {
  it("ouvre la session avec un cookie HttpOnly, Secure et SameSite=Strict", async () => {
    const res = await handleApi(post("/api/session", { key: KEY }), ENV);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: "Kevin" });
    const cookie = res.headers.get("Set-Cookie");
    assert.match(cookie, new RegExp(`^cocon_key=${KEY};`));
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api", "Max-Age="]) {
      assert.ok(cookie.includes(flag), `attribut manquant : ${flag}`);
    }
  });

  it("refuse une mauvaise clé sans poser de cookie", async () => {
    const res = await handleApi(post("/api/session", { key: "mauvaise-cle-mais-assez-longue" }), ENV);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Set-Cookie"), null);
  });

  it("refuse une connexion venant d'un autre site", async () => {
    const res = await handleApi(post("/api/session", { key: KEY }, "https://pirate.example"), ENV);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("Set-Cookie"), null);
  });

  it("refuse une connexion sans origine", async () => {
    const res = await handleApi(post("/api/session", { key: KEY }, null), ENV);
    assert.equal(res.status, 403);
  });

  it("refuse un corps trop gros ou illisible", async () => {
    const huge = await handleApi(post("/api/session", { key: "a".repeat(2000) }), ENV);
    assert.equal(huge.status, 400);
    const broken = await handleApi(post("/api/session", "{pas du json"), ENV);
    assert.equal(broken.status, 400);
  });

  it("ferme la session", async () => {
    const req = new Request(`${ORIGIN}/api/session`, { method: "DELETE", headers: { Origin: ORIGIN } });
    const res = await handleApi(req, ENV);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Set-Cookie"), /^cocon_key=;.*Max-Age=0/);
  });
});

describe("diagnostic", () => {
  it("renvoie unités, capacités nommées et état de la consommation", async () => {
    const { fetchImpl, calls } = fakeAtlantic(defaultRoutes());
    const res = await handleApi(get("/api/diagnostic"), ENV, { fetchImpl });
    assert.equal(res.status, 200);
    const report = await res.json();

    assert.equal(report.account.name, "Maison");
    assert.equal(report.account.rateLimit, 30);
    assert.equal(report.devices.length, 1);
    assert.equal(report.devices[0].capabilities[0].label, "HVAC mode");
    assert.deepEqual(Object.keys(report.catalogue), ["7"]);
    assert.equal(report.consumption.declared, false);
    assert.equal(report.consumption.available, false);

    // Connexion envoyée comme l'application Cozytouch.
    const login = calls.find((c) => c.path === "/users/token");
    assert.equal(login.init.headers.Authorization, `Basic ${ENV.COZYTOUCH_CLIENT_ID}`);
    assert.match(String(login.init.body), /username=GA-PRIVATEPERSON%2Ftest%40exemple.fr/);
  });

  it("masque adresse, localisation et numéros de série", async () => {
    const { fetchImpl } = fakeAtlantic(defaultRoutes());
    const res = await handleApi(get("/api/diagnostic"), ENV, { fetchImpl });
    const text = await res.text();
    for (const secret of ["1 rue Secrète", "SN-123", "Ville-Secrète"]) {
      assert.ok(!text.includes(secret), `donnée non masquée : ${secret}`);
    }
    assert.ok(text.includes("[masqué]"));
  });

  it("réutilise le jeton entre deux requêtes", async () => {
    const { fetchImpl, calls } = fakeAtlantic(defaultRoutes());
    await handleApi(get("/api/diagnostic"), ENV, { fetchImpl });
    await handleApi(get("/api/diagnostic"), ENV, { fetchImpl });
    assert.equal(calls.filter((c) => c.path === "/users/token").length, 1);
  });

  it("se reconnecte avant l'expiration du jeton (marge d'une minute)", async () => {
    const { fetchImpl, calls } = fakeAtlantic(defaultRoutes());
    let clock = 1_000_000;
    const now = () => clock;
    await handleApi(get("/api/diagnostic"), ENV, { fetchImpl, now });
    clock += 3600_000 - 30_000; // 30 s avant l'expiration annoncée : déjà trop tard
    await handleApi(get("/api/diagnostic"), ENV, { fetchImpl, now });
    assert.equal(calls.filter((c) => c.path === "/users/token").length, 2);
  });

  it("se reconnecte une fois si Atlantic rejette le jeton", async () => {
    let setupCalls = 0;
    const routes = defaultRoutes();
    routes["/magellan/cozytouch/setupviewv2"] = () => {
      setupCalls += 1;
      return setupCalls === 1 ? [401, {}] : [200, SETUP];
    };
    const { fetchImpl, calls } = fakeAtlantic(routes);
    const res = await handleApi(get("/api/diagnostic"), ENV, { fetchImpl });
    assert.equal(res.status, 200);
    assert.equal(calls.filter((c) => c.path === "/users/token").length, 2);
  });

  it("explique un mot de passe Cozytouch refusé", async () => {
    const routes = defaultRoutes();
    routes["/users/token"] = () => [400, { error: "invalid_grant" }];
    const { fetchImpl } = fakeAtlantic(routes);
    const res = await handleApi(get("/api/diagnostic"), ENV, { fetchImpl });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "AUTH_REFUSED");
  });

  it("relaie la limite de requêtes d'Atlantic avec le délai d'attente", async () => {
    const routes = defaultRoutes();
    routes["/magellan/cozytouch/setupviewv2"] = () => [429, {}, { "Retry-After": "42" }];
    const { fetchImpl } = fakeAtlantic(routes);
    const res = await handleApi(get("/api/diagnostic"), ENV, { fetchImpl });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "42");
    assert.equal((await res.json()).error.code, "RATE_LIMITED");
  });

  it("signale un cloud Atlantic trop lent", async () => {
    const routes = defaultRoutes();
    routes["/magellan/cozytouch/setupviewv2"] = timeoutError;
    const { fetchImpl } = fakeAtlantic(routes);
    const res = await handleApi(get("/api/diagnostic"), ENV, { fetchImpl });
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error.code, "TIMEOUT");
  });

  it("reste utilisable si le catalogue ou la consommation échouent", async () => {
    const routes = defaultRoutes();
    routes["/magellan/productmodels/capabilities"] = timeoutError;
    routes["/magellan/setups/4242/consumptions"] = () => [429, {}];
    const { fetchImpl } = fakeAtlantic(routes);
    const res = await handleApi(get("/api/diagnostic"), ENV, { fetchImpl });
    assert.equal(res.status, 200);
    const report = await res.json();
    assert.equal(report.devices.length, 1);
    assert.equal(report.catalogueError.code, "TIMEOUT");
    assert.equal(report.consumption.error.code, "RATE_LIMITED");
    assert.equal(report.consumption.available, false);
  });

  it("signale les secrets Cozytouch manquants", async () => {
    const { fetchImpl } = fakeAtlantic(defaultRoutes());
    const env = { ...ENV, COZYTOUCH_PASSWORD: "" };
    const res = await handleApi(get("/api/diagnostic"), env, { fetchImpl });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /COZYTOUCH_PASSWORD/);
  });
});
