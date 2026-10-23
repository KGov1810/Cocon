// Mode Absence : lecture de l'état et programmation pour toute la maison.
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

/** Horloge factice : 1 000 s après l'époque Unix ; le test ne dort jamais. */
const NOW_S = 1000;
function fakeTime() {
  let clock = NOW_S * 1000;
  return { now: () => clock, sleep: async (ms) => void (clock += ms) };
}

/** Faux Atlantic : enregistre le PUT du logement et les écritures de capacités. */
function fakeAtlantic({ setup = makeSetup(), putStatus = 204, writeStatus = 201, executionState = 3 } = {}) {
  const puts = [];
  const writes = [];
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (pathname === "/users/token") return reply(200, { access_token: "jeton", expires_in: 3600 });
    if (pathname === "/magellan/cozytouch/setupviewv2") return reply(200, [setup]);
    if (pathname === `/magellan/v2/setups/${setup.id}` && init.method === "PUT") {
      puts.push(JSON.parse(init.body));
      return reply(putStatus);
    }
    if (pathname === "/magellan/executions/writecapability") {
      writes.push(JSON.parse(init.body));
      return writeStatus === 201 ? reply(201, 900 + writes.length) : reply(writeStatus, {});
    }
    if (/^\/magellan\/executions\/\d+$/.test(pathname)) return reply(200, { state: executionState });
    return reply(404, {});
  };
  return { fetchImpl, puts, writes };
}

const cookie = { Cookie: `cocon_key=${KEY}` };
const state = () => new Request(`${ORIGIN}/api/state`, { headers: cookie });
const setAbsence = (body, headers = { Origin: ORIGIN, ...cookie }) =>
  new Request(`${ORIGIN}/api/absence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const clearAbsence = () =>
  new Request(`${ORIGIN}/api/absence`, { method: "DELETE", headers: { Origin: ORIGIN, ...cookie } });

beforeEach(() => {
  resetTokenCache();
  resetSetupCache();
});

describe("lecture de l'absence", () => {
  it("indique qu'aucune absence n'est prévue", async () => {
    const { fetchImpl } = fakeAtlantic();
    const body = await (await handleApi(state(), ENV, { fetchImpl, ...fakeTime() })).json();
    assert.deepEqual(body.absence, { available: true, status: "off", start: null, end: null });
  });

  it("lit une absence programmée et ses dates", async () => {
    const setup = makeSetup({ hub: { 152: "2", 222: "[5000,90000]" } });
    const { fetchImpl } = fakeAtlantic({ setup });
    const body = await (await handleApi(state(), ENV, { fetchImpl, ...fakeTime() })).json();
    assert.deepEqual(body.absence, { available: true, status: "scheduled", start: 5000, end: 90000 });
  });

  it("lit une absence en cours", async () => {
    const setup = makeSetup({ hub: { 152: "1", 222: "[900,90000]" } });
    const { fetchImpl } = fakeAtlantic({ setup });
    const body = await (await handleApi(state(), ENV, { fetchImpl, ...fakeTime() })).json();
    assert.equal(body.absence.status, "on");
  });
});

describe("programmation de l'absence", () => {
  const window = { start: NOW_S, end: NOW_S + 86400 };

  it("enregistre la fenêtre sur le logement puis sur le hub", async () => {
    const { fetchImpl, puts, writes } = fakeAtlantic();
    const res = await handleApi(setAbsence(window), ENV, { fetchImpl, ...fakeTime() });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "confirmed");

    assert.equal(puts.length, 1);
    // Le logement est renvoyé avec ses propres champs modifiables, plus l'absence.
    assert.deepEqual(puts[0], {
      address: "1 rue Secrète",
      name: "setup1",
      numberOfRooms: 2,
      type: 1,
      absence: { startDate: window.start, endDate: window.end },
    });
    assert.deepEqual(writes, [{ capabilityId: 222, deviceId: 1000, value: `[${window.start},${window.end}]` }]);
  });

  it("annule l'absence", async () => {
    const { fetchImpl, puts, writes } = fakeAtlantic();
    const res = await handleApi(clearAbsence(), ENV, { fetchImpl, ...fakeTime() });
    assert.equal(res.status, 200);
    assert.deepEqual(puts[0].absence, {});
    assert.deepEqual(writes, [{ capabilityId: 222, deviceId: 1000, value: "[0,0]" }]);
  });

  it("répond « en attente » si le hub ne confirme pas la fenêtre", async () => {
    const { fetchImpl } = fakeAtlantic({ executionState: 4 });
    const res = await handleApi(setAbsence(window), ENV, { fetchImpl, ...fakeTime() });
    assert.equal(res.status, 202);
  });

  it("signale un logement qui refuse l'absence, sans rien écrire sur le hub", async () => {
    const { fetchImpl, writes } = fakeAtlantic({ putStatus: 400 });
    const res = await handleApi(setAbsence(window), ENV, { fetchImpl, ...fakeTime() });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "COMMAND_REFUSED");
    assert.equal(writes.length, 0);
  });

  const invalid = {
    "retour avant le départ": { start: NOW_S + 3600, end: NOW_S + 1800 },
    "départ dans le passé": { start: NOW_S - 3600, end: NOW_S + 3600 },
    "retour dans plus d'un an": { start: NOW_S, end: NOW_S + 400 * 86400 },
    "dates non entières": { start: NOW_S + 0.5, end: NOW_S + 3600 },
    "dates absentes": { start: NOW_S },
    "absence de moins de 15 minutes": { start: NOW_S, end: NOW_S + 600 },
  };
  for (const [name, body] of Object.entries(invalid)) {
    it(`refuse : ${name}`, async () => {
      const { fetchImpl, puts } = fakeAtlantic();
      const res = await handleApi(setAbsence(body), ENV, { fetchImpl, ...fakeTime() });
      assert.equal(res.status, 422);
      assert.equal(puts.length, 0);
    });
  }

  it("exige une session et l'origine de l'application", async () => {
    const { fetchImpl, puts } = fakeAtlantic();
    const noSession = await handleApi(setAbsence(window, { Origin: ORIGIN }), ENV, { fetchImpl, ...fakeTime() });
    assert.equal(noSession.status, 401);
    const foreign = await handleApi(setAbsence(window, { Origin: "https://pirate.example", ...cookie }), ENV, {
      fetchImpl,
      ...fakeTime(),
    });
    assert.equal(foreign.status, 403);
    assert.equal(puts.length, 0);
  });
});
