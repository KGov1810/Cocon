// Programme hebdomadaire : lecture, prochain changement, écriture validée.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CommandError, planCommand, readRooms } from "../src/rooms.js";
import { DEFAULT_DAY, makeSetup } from "./fixtures/setup.js";

/** Mercredi 21 octobre 2026, 21 h 30 à l'heure du logement (UTC+2). */
const WEDNESDAY_2130 = Date.UTC(2026, 9, 21, 19, 30);
const at = (hours, minutes = 0, day = 21) => Date.UTC(2026, 9, day, hours - 2, minutes);

const chambre = (options = {}, now = WEDNESDAY_2130) =>
  readRooms(makeSetup(options), now).find((r) => r.name === "Chambre");

const pad = (entries) => JSON.stringify([...entries, ...Array(10 - entries.length).fill([0, 0, 0])]);

describe("lecture du programme", () => {
  it("lit les deux programmes, les contraintes et l'état Arrêt disponible", () => {
    const { program } = chambre();
    assert.equal(program.available, true);
    assert.equal(program.active, false);
    assert.equal(program.offAvailable, true);
    assert.deepEqual(program.limits, { step: 15, minGap: 60, maxPerDay: 8, minPerWeek: 1 });
    const expected = [
      { minutes: 360, setpoint: 20, off: false },
      { minutes: 1320, setpoint: 19, off: false },
    ];
    assert.equal(program.heat.length, 7);
    assert.deepEqual(program.heat[0], expected);
    assert.deepEqual(program.cool[6], expected);
  });

  it("lit un créneau Arrêt, sans consigne", () => {
    const { program } = chambre({ chambre: { 100320: pad([[360, 20, 0], [1380, 16, 1]]) } });
    assert.deepEqual(program.heat[0][1], { minutes: 1380, setpoint: null, off: true });
  });

  it("ignore un jour illisible sans casser les autres", () => {
    const { program } = chambre({ chambre: { 100321: "pas un tableau" } });
    assert.deepEqual(program.heat[1], []);
    assert.equal(program.heat[0].length, 2);
  });

  it("n'expose pas de programme si l'unité n'en déclare pas", () => {
    const setup = makeSetup();
    const device = setup.devices.find((d) => d.deviceId === 1001);
    device.capabilities = device.capabilities.filter((c) => c.capabilityId !== 184);
    assert.equal(readRooms(setup, WEDNESDAY_2130).find((r) => r.id === 1001).program, undefined);
  });

  it("signale le programme actif et la dérogation en cours", () => {
    const { program } = chambre({ chambre: { 184: "1", 157: "1", 159: "45" } });
    assert.equal(program.active, true);
    assert.deepEqual(program.override, { active: true, remainingMinutes: 45 });
  });
});

describe("prochain changement", () => {
  it("donne le prochain créneau du jour, dans le programme du mode en cours", () => {
    assert.deepEqual(chambre({ chambre: { 184: "1" } }).program.next, {
      day: 2,
      minutes: 1320,
      inMinutes: 30,
      setpoint: 19,
      off: false,
    });
  });

  it("passe au lendemain après le dernier créneau", () => {
    const next = chambre({ chambre: { 184: "1" } }, at(23, 0)).program.next;
    assert.equal(next.day, 3);
    assert.equal(next.minutes, 360);
    assert.equal(next.inMinutes, 7 * 60);
  });

  it("saute les jours sans créneau", () => {
    const empty = pad([]);
    const next = chambre({ chambre: { 184: "1", 100323: empty } }, at(23, 0)).program.next;
    assert.equal(next.day, 4);
    assert.equal(next.inMinutes, 7 * 60 + 24 * 60);
  });

  it("suit le programme froid en mode froid", () => {
    const cool = pad([[360, 24, 0], [1350, 26, 0]]);
    const next = chambre({ chambre: { 184: "1", 7: "3", 100329: cool } }).program.next;
    assert.equal(next.setpoint, 26);
    assert.equal(next.inMinutes, 60);
  });

  it("suit aussi le programme froid en déshumidification", () => {
    const cool = pad([[360, 24, 0], [1350, 26, 0]]);
    assert.equal(chambre({ chambre: { 184: "1", 7: "8", 100329: cool } }).program.next.setpoint, 26);
  });

  it("n'en donne pas si le programme est inactif ou vide", () => {
    assert.equal(chambre().program.next, null);
    const empty = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [100320 + i, pad([])]));
    assert.equal(chambre({ chambre: { 184: "1", ...empty } }).program.next, null);
  });
});

describe("commandes du programme", () => {
  it("active ou suspend le programme", () => {
    assert.deepEqual(planCommand(chambre(), "program", true), [{ capabilityId: 184, value: "1" }]);
    assert.deepEqual(planCommand(chambre(), "program", false), [{ capabilityId: 184, value: "0" }]);
    assert.throws(() => planCommand(chambre(), "program", "oui"), CommandError);
  });

  it("déroge jusqu'au prochain créneau quand on change la consigne", () => {
    assert.deepEqual(planCommand(chambre({ chambre: { 184: "1" } }), "setpoint", 21), [
      { capabilityId: 158, value: "30" },
      { capabilityId: 157, value: "1" },
      { capabilityId: 40, value: "21" },
    ]);
  });

  it("borne la dérogation à 24 h si le prochain créneau est plus loin", () => {
    // Un seul créneau dans la semaine, le lundi : depuis mercredi soir, plus de 4 jours.
    const empty = pad([]);
    const days = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [100321 + i, empty]));
    const [duration] = planCommand(chambre({ chambre: { 184: "1", ...days } }), "setpoint", 21);
    assert.deepEqual(duration, { capabilityId: 158, value: "1440" });
  });

  it("écrit un jour sur plusieurs jours, créneaux triés, Arrêt compris", () => {
    const writes = planCommand(chambre(), "schedule", {
      kind: "heat",
      days: [0, 1],
      slots: [
        { minutes: 1380, off: true },
        { minutes: 390, setpoint: 21, off: false },
      ],
    });
    const value = pad([[390, 21, 0], [1380, 16, 1]]);
    assert.deepEqual(writes, [
      { capabilityId: 100320, value },
      { capabilityId: 100321, value },
    ]);
  });

  it("enregistre un créneau Arrêt du programme froid avec la consigne minimale du froid", () => {
    const [write] = planCommand(chambre(), "schedule", {
      kind: "cool",
      days: [6],
      slots: [{ minutes: 0, off: true }],
    });
    assert.deepEqual(write, { capabilityId: 100333, value: pad([[0, 18, 1]]) });
  });

  it("accepte un jour vide tant que la semaine garde un créneau", () => {
    const [write] = planCommand(chambre(), "schedule", { kind: "heat", days: [5], slots: [] });
    assert.deepEqual(write, { capabilityId: 100325, value: pad([]) });
  });

  const invalid = {
    "horaire hors du pas de 15 min": { kind: "heat", days: [0], slots: [{ minutes: 370, setpoint: 20 }] },
    "moins d'une heure entre deux changements": {
      kind: "heat",
      days: [0],
      slots: [
        { minutes: 360, setpoint: 20 },
        { minutes: 405, setpoint: 19 },
      ],
    },
    "plus de 8 changements": {
      kind: "heat",
      days: [0],
      slots: Array.from({ length: 9 }, (_, i) => ({ minutes: i * 120, setpoint: 20 })),
    },
    "consigne chaud trop haute": { kind: "heat", days: [0], slots: [{ minutes: 0, setpoint: 31 }] },
    "consigne froid trop basse": { kind: "cool", days: [0], slots: [{ minutes: 0, setpoint: 17 }] },
    "demi-degré": { kind: "heat", days: [0], slots: [{ minutes: 0, setpoint: 20.5 }] },
    "minuit dépassé": { kind: "heat", days: [0], slots: [{ minutes: 1440, setpoint: 20 }] },
    "jour en double": { kind: "heat", days: [0, 0], slots: [] },
    "jour inexistant": { kind: "heat", days: [7], slots: [] },
    "aucun jour": { kind: "heat", days: [], slots: [] },
    "programme inconnu": { kind: "auto", days: [0], slots: [] },
    "créneaux absents": { kind: "heat", days: [0] },
    "semaine entière vide": { kind: "heat", days: [0, 1, 2, 3, 4, 5, 6], slots: [] },
  };
  for (const [name, value] of Object.entries(invalid)) {
    it(`refuse : ${name}`, () => {
      assert.throws(() => planCommand(chambre(), "schedule", value), CommandError);
    });
  }

  it("refuse un créneau Arrêt si l'unité ne le déclare pas", () => {
    const room = chambre({ chambre: { 100013: "0" } });
    assert.throws(
      () => planCommand(room, "schedule", { kind: "heat", days: [0], slots: [{ minutes: 0, off: true }] }),
      CommandError,
    );
  });

  it("le programme d'origine se relit à l'identique une fois réécrit", () => {
    const [write] = planCommand(chambre(), "schedule", {
      kind: "heat",
      days: [0],
      slots: chambre().program.heat[0],
    });
    assert.equal(write.value, DEFAULT_DAY);
  });
});
