/**
 * Serveur d'essai pour les tests dans le navigateur (npm run e2e).
 *
 * Il sert l'application (dossier public/, avec les en-têtes de sécurité de
 * public/_headers) et passe /api/* au vrai code du relais (src/worker.js).
 * Atlantic est remplacé par un faux cloud en mémoire : aucun identifiant réel,
 * aucun appel réseau, et .dev.vars n'est jamais lu.
 *
 * Le faux cloud se comporte comme le vrai, en plus rapide :
 * - une exécution est « en attente », puis « en cours », puis terminée après 1,2 s ;
 * - la nouvelle valeur n'apparaît dans la vue du logement qu'après 3 s ;
 * - une absence est appliquée au hub 1 s après son enregistrement.
 */

import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { resetTokenCache } from "../src/atlantic.js";
import { resetSetupCache } from "../src/commands.js";
import { handleApi } from "../src/worker.js";
import { makeSetup } from "../test/fixtures/setup.js";

export const ACCESS_KEY = "cle-locale-de-test-tres-longue";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const ENV = {
  ACCESS_KEYS: `Essai:${ACCESS_KEY}`,
  COZYTOUCH_EMAIL: "essai@example.invalid",
  COZYTOUCH_PASSWORD: "faux",
  COZYTOUCH_CLIENT_ID: "faux",
  ATLANTIC_API: "https://atlantic.invalid",
};

/** Faux cloud Atlantic, sous forme de fonction fetch. */
function fakeAtlantic() {
  const setup = makeSetup();
  const executions = new Map();
  let nextExecution = 7000;

  const device = (id) => setup.devices.find((d) => d.deviceId === id);
  const getCap = (id, cap) => device(id)?.capabilities.find((c) => c.capabilityId === cap)?.value;
  const setCap = (id, cap, value) => {
    const found = device(id)?.capabilities.find((c) => c.capabilityId === cap);
    if (found) found.value = String(value);
  };
  const reply = (status, body) =>
    new Promise((resolve) => setTimeout(() => resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })), 120));

  return async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    if (pathname === "/users/token") return reply(200, { access_token: "faux", expires_in: 3600 });
    if (init.headers?.Authorization !== "Bearer faux") return reply(401, {});
    if (pathname === "/magellan/cozytouch/setupviewv2") return reply(200, [structuredClone(setup)]);
    if (pathname === "/magellan/productmodels/capabilities") return reply(200, []);
    if (pathname.startsWith("/magellan/setups/")) return reply(200, []);

    if (pathname === `/magellan/v2/setups/${setup.id}` && method === "PUT") {
      const { absence = {} } = JSON.parse(init.body);
      setTimeout(() => {
        const hub = setup.devices.find((d) => d.capabilities.some((c) => c.capabilityId === 222)).deviceId;
        const started = absence.startDate && absence.startDate <= Date.now() / 1000;
        setCap(hub, 152, absence.startDate ? (started ? "1" : "2") : "0");
        setCap(hub, 222, absence.startDate ? `[${absence.startDate},${absence.endDate}]` : "[0,0]");
      }, 1000);
      return reply(204);
    }

    if (pathname === "/magellan/executions/writecapability") {
      const { deviceId, capabilityId, value } = JSON.parse(init.body);
      const id = ++nextExecution;
      executions.set(id, Date.now());
      setTimeout(() => {
        setCap(deviceId, capabilityId, value);
        // Une dérogation dure la durée demandée (158) ; elle se lit dans 159.
        if (capabilityId === 157) setCap(deviceId, 159, value === "1" ? getCap(deviceId, 158) : "0");
      }, 3000);
      return reply(201, id);
    }

    const execution = pathname.match(/^\/magellan\/executions\/(\d+)$/);
    if (execution) {
      const age = Date.now() - executions.get(Number(execution[1]));
      return reply(200, { state: age < 600 ? 1 : age < 1200 ? 2 : 3 });
    }
    return reply(404, {});
  };
}

/** En-têtes de public/_headers (bloc « /* »), appliqués à chaque fichier. */
async function readHeaders() {
  const lines = (await readFile(join(PUBLIC, "_headers"), "utf8")).split("\n");
  return Object.fromEntries(
    lines
      .filter((line) => /^\s+\S+:/.test(line))
      .map((line) => {
        const at = line.indexOf(":");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
}

async function serveFile(pathname, headers) {
  const name = pathname === "/" ? "index.html" : pathname.slice(1) + (extname(pathname) ? "" : ".html");
  const file = join(PUBLIC, name);
  if (!file.startsWith(PUBLIC) || name.startsWith("_")) return new Response("Introuvable", { status: 404 });
  try {
    const body = await readFile(file);
    return new Response(body, { headers: { ...headers, "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" } });
  } catch {
    return new Response("Introuvable", { status: 404 });
  }
}

/**
 * Démarre le serveur sur un port libre, avec un faux cloud neuf.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startServer() {
  resetTokenCache();
  resetSetupCache();
  const fetchImpl = fakeAtlantic();
  const headers = await readHeaders();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req),
      duplex: "half",
    });
    const response = url.pathname.startsWith("/api/")
      ? await handleApi(request, ENV, { fetchImpl })
      : await serveFile(url.pathname, headers);
    const out = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://localhost:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
