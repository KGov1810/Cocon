// Routes de l'application : état des pièces et envoi des commandes.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { resetTokenCache } from "../src/atlantic.js";
import { resetSetupCache } from "../src/commands.js";
import { handleApi } from "../src/worker.js";
import { makeSetup } from "./fixtures/setup.js";

const ORIGIN = "https://cocon.test";
const KEY = "cle-de-test-suffisamment-longue";
const ENV = {
  COZYTOUCH_EMAIL: "test@exemple.fr",
  COZYTOUCH_PASSWORD: "secret",
  COZYTOUCH_CLIENT_ID: "Y2xpZW50OnNlY3JldA==",
  ACCESS_KEYS: `Kevin:${KEY}`,
  ATLANTIC_API: "https://atlantic.test",
};

/**
 * Faux cloud Atlantic qui accepte les écritures.
 * `executionStates` : états successifs renvoyés pour chaque exécution.
 */
function fakeAtlantic({
  setup = makeSetup(),
  executionStates = [1, 3],
  writeStatus = 201,
  onSetup,
  clock, // si fourni : une exécution est terminée `executionDelayMs` après son écriture
  executionDelayMs = 1500,
} = {}) {
  const calls = [];
  const writes = [];
  const polls = new Map();
  const writtenAt = new Map();
  let nextExecution = 500;

  const reply = (status, body) => new Response(JSON.stringify(body), { status });

  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    calls.push(pathname);
    if (pathname === "/users/token") return reply(200, { access_token: "jeton", expires_in: 3600 });
    if (pathname === "/magellan/cozytouch/setupviewv2") {
      onSetup?.();
      return reply(200, [setup]);
    }
    if (pathname === "/magellan/executions/writecapability") {
      writes.push(JSON.parse(init.body));
      if (writeStatus !== 201) return reply(writeStatus, {});
      nextExecution += 1;
      writtenAt.set(String(nextExecution), clock?.());
      return reply(201, nextExecution);
    }
    const execution = pathname.match(/^\/magellan\/executions\/(\d+)$/);
    if (execution) {
      const id = execution[1];
      if (clock) return reply(200, { state: clock() - writtenAt.get(id) >= executionDelayMs ? 3 : 1 });
      const count = polls.get(id) ?? 0;
      polls.set(id, count + 1);
      const state = executionStates[Math.min(count, executionStates.length - 1)];
      return reply(200, { state });
    }
    return reply(404, {});
  };
  return { fetchImpl, calls, writes };
}

/** Horloge et attente factices : le test ne dort jamais. */
function fakeTime() {
  let clock = 1_000_000;
  return { now: () => clock, sleep: async (ms) => void (clock += ms) };
}

const getState = () => new Request(`${ORIGIN}/api/state`, { headers: { Cookie: `cocon_key=${KEY}` } });

function command(roomId, body, { origin = ORIGIN, cookie = true } = {}) {
  return new Request(`${ORIGIN}/api/rooms/${roomId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: `cocon_key=${KEY}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  resetTokenCache();
  resetSetupCache();
});

describe("état des pièces", () => {
  it("renvoie les deux pièces avec leurs réglages, sans données internes", async () => {
    const { fetchImpl } = fakeAtlantic();
    const res = await handleApi(getState(), ENV, { fetchImpl, ...fakeTime() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.rooms.map((r) => [r.id, r.name, r.mode]),
      [
        [1001, "Chambre", "heat"],
        [1003, "Salon", "off"],
      ],
    );
    assert.equal(body.rooms[0].setpoint, 26);
    assert.ok(typeof body.updatedAt === "string");
    assert.ok(!JSON.stringify(body).includes("100044"), "aucune capacité brute dans la réponse");
  });

  it("exige une session", async () => {
    const { fetchImpl } = fakeAtlantic();
    const req = new Request(`${ORIGIN}/api/state`);
    assert.equal((await handleApi(req, ENV, { fetchImpl })).status, 401);
  });
});

describe("commandes", () => {
  it("écrit la capacité puis attend la confirmation d'Atlantic", async () => {
    const { fetchImpl, writes } = fakeAtlantic({ executionStates: [1, 2, 3] });
    const res = await handleApi(command(1001, { setting: "mode", value: "cool" }), ENV, {
      fetchImpl,
      ...fakeTime(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "confirmed");
    assert.ok(body.elapsedMs > 0);
    assert.deepEqual(writes, [{ capabilityId: 7, deviceId: 1001, value: "3" }]);
  });

  it("envoie les écritures dans l'ordre (dérogation puis consigne)", async () => {
    const setup = makeSetup({ chambre: { 184: "1" } });
    const { fetchImpl, writes } = fakeAtlantic({ setup });
    const res = await handleApi(command(1001, { setting: "setpoint", value: 21 }), ENV, {
      fetchImpl,
      ...fakeTime(),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      writes.map((w) => [w.capabilityId, w.value]),
      [
        // Horloge factice : jeudi 02:16 heure du logement ; prochain créneau à 06:00.
        [158, "224"],
        [157, "1"],
        [40, "21"],
      ],
    );
  });

  const weekdays = {
    setting: "schedule",
    value: { kind: "heat", days: [0, 1, 2, 3, 4], slots: [{ minutes: 390, setpoint: 21 }] },
  };
  const executionPolls = (calls) => calls.filter((path) => /^\/magellan\/executions\/\d+$/.test(path)).length;

  it("écrit un programme sur plusieurs jours sans dépasser le quota d'Atlantic", async () => {
    const time = fakeTime();
    const { fetchImpl, writes, calls } = fakeAtlantic({ clock: time.now });
    const res = await handleApi(command(1001, weekdays), ENV, { fetchImpl, ...time });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "confirmed");
    assert.deepEqual(
      writes.map((w) => w.capabilityId),
      [100320, 100321, 100322, 100323, 100324],
    );
    // Suivre chaque jour jusqu'à sa confirmation coûterait au moins 2 lectures par
    // jour ; on suit la dernière écriture puis on vérifie les autres une fois.
    assert.ok(executionPolls(calls) <= writes.length + 2, `${executionPolls(calls)} lectures d'exécution`);
  });

  it("répond « en attente » si le programme n'est pas encore confirmé", async () => {
    const { fetchImpl } = fakeAtlantic({ executionStates: [1] });
    const res = await handleApi(command(1001, weekdays), ENV, { fetchImpl, ...fakeTime() });
    assert.equal(res.status, 202);
  });

  it("signale un programme refusé par l'unité", async () => {
    const { fetchImpl } = fakeAtlantic({ executionStates: [5] });
    const res = await handleApi(command(1001, weekdays), ENV, { fetchImpl, ...fakeTime() });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "COMMAND_FAILED");
  });

  it("répond « en attente » si Atlantic ne confirme pas à temps", async () => {
    const { fetchImpl } = fakeAtlantic({ executionStates: [1] });
    const res = await handleApi(command(1001, { setting: "fan", value: "high" }), ENV, {
      fetchImpl,
      ...fakeTime(),
    });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).status, "pending");
  });

  it("signale une exécution refusée par Atlantic", async () => {
    const { fetchImpl } = fakeAtlantic({ executionStates: [1, 5] });
    const res = await handleApi(command(1001, { setting: "fan", value: "high" }), ENV, {
      fetchImpl,
      ...fakeTime(),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "COMMAND_FAILED");
  });

  it("signale une écriture rejetée par Atlantic", async () => {
    const { fetchImpl } = fakeAtlantic({ writeStatus: 400 });
    const res = await handleApi(command(1001, { setting: "fan", value: "high" }), ENV, {
      fetchImpl,
      ...fakeTime(),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "COMMAND_REFUSED");
  });

  it("refuse une valeur invalide sans rien écrire", async () => {
    const { fetchImpl, writes } = fakeAtlantic();
    const res = await handleApi(command(1001, { setting: "setpoint", value: 45 }), ENV, {
      fetchImpl,
      ...fakeTime(),
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, "INVALID_VALUE");
    assert.equal(writes.length, 0);
  });

  it("refuse d'écrire sur un appareil qui n'est pas une pièce (le hub)", async () => {
    const { fetchImpl, writes } = fakeAtlantic();
    const res = await handleApi(command(1000, { setting: "mode", value: "off" }), ENV, {
      fetchImpl,
      ...fakeTime(),
    });
    assert.equal(res.status, 404);
    assert.equal(writes.length, 0);
  });

  it("refuse un identifiant de pièce mal formé", async () => {
    const { fetchImpl, writes } = fakeAtlantic();
    const res = await handleApi(command("1001abc", { setting: "mode", value: "off" }), ENV, {
      fetchImpl,
      ...fakeTime(),
    });
    assert.equal(res.status, 404);
    assert.equal(writes.length, 0);
  });

  it("refuse un corps de requête mal formé", async () => {
    const { fetchImpl } = fakeAtlantic();
    for (const body of ["{pas du json", JSON.stringify({ setting: 3 }), JSON.stringify([1])]) {
      const res = await handleApi(command(1001, body), ENV, { fetchImpl, ...fakeTime() });
      assert.equal(res.status, 400, `corps accepté à tort : ${body}`);
    }
  });

  it("exige une session et l'origine de l'application", async () => {
    const { fetchImpl, writes } = fakeAtlantic();
    const noSession = await handleApi(command(1001, { setting: "mode", value: "off" }, { cookie: false }), ENV, {
      fetchImpl,
    });
    assert.equal(noSession.status, 401);
    const foreign = await handleApi(
      command(1001, { setting: "mode", value: "off" }, { origin: "https://pirate.example" }),
      ENV,
      { fetchImpl },
    );
    assert.equal(foreign.status, 403);
    assert.equal(writes.length, 0);
  });

  it("réutilise l'état lu juste avant au lieu de relire le logement", async () => {
    let setupReads = 0;
    const { fetchImpl } = fakeAtlantic({ onSetup: () => (setupReads += 1) });
    const time = fakeTime();
    await handleApi(getState(), ENV, { fetchImpl, ...time });
    await handleApi(command(1001, { setting: "fan", value: "low" }), ENV, { fetchImpl, ...time });
    assert.equal(setupReads, 1);
  });

  it("relit le logement après une commande, l'état ayant changé", async () => {
    let setupReads = 0;
    const { fetchImpl } = fakeAtlantic({ onSetup: () => (setupReads += 1) });
    const time = fakeTime();
    await handleApi(command(1001, { setting: "fan", value: "low" }), ENV, { fetchImpl, ...time });
    await handleApi(command(1001, { setting: "fan", value: "high" }), ENV, { fetchImpl, ...time });
    assert.equal(setupReads, 2);
  });

  it("n'accepte qu'un identifiant d'exécution numérique (pas de chemin injecté)", async () => {
    const { fetchImpl, calls } = fakeAtlantic();
    const tampered = async (url, init) => {
      if (new URL(url).pathname === "/magellan/executions/writecapability") {
        return new Response(JSON.stringify("../../users/token"), { status: 201 });
      }
      return fetchImpl(url, init);
    };
    const res = await handleApi(command(1001, { setting: "fan", value: "low" }), ENV, {
      fetchImpl: tampered,
      ...fakeTime(),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "COMMAND_REFUSED");
    assert.ok(!calls.some((path) => path.includes("..")));
  });

  it("relit le logement si l'état en cache est trop ancien", async () => {
    let setupReads = 0;
    const { fetchImpl } = fakeAtlantic({ onSetup: () => (setupReads += 1) });
    const time = fakeTime();
    await handleApi(getState(), ENV, { fetchImpl, ...time });
    await time.sleep(5 * 60_000);
    await handleApi(command(1001, { setting: "fan", value: "low" }), ENV, { fetchImpl, ...time });
    assert.equal(setupReads, 2);
  });
});
