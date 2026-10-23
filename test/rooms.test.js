// Modèle des pièces : ce que l'application affiche et accepte pour chaque unité.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CommandError, planCommand, readRooms } from "../src/rooms.js";
import { makeSetup } from "./fixtures/setup.js";

const roomsOf = (options) => readRooms(makeSetup(options));
const chambre = (options) => roomsOf(options).find((r) => r.name === "Chambre");
const salon = (options) => roomsOf(options).find((r) => r.name === "Salon");

describe("lecture des pièces", () => {
  it("ne garde que les pièces climatisées, nommées comme dans Cozytouch", () => {
    const rooms = roomsOf();
    assert.deepEqual(
      rooms.map((r) => [r.id, r.name]),
      [
        [1001, "Chambre"],
        [1003, "Salon"],
      ],
    );
  });

  it("prend le nom de la zone si la pièce n'a pas de nom", () => {
    assert.equal(chambre({ chambre: { 154: "" } }).name, "Chambre");
  });

  it("lit le mode, la consigne active et la température mesurée", () => {
    const room = chambre();
    assert.equal(room.mode, "heat");
    assert.equal(room.setpoint, 26);
    assert.equal(room.temperature, 22.25);
  });

  it("lit la consigne froid en mode froid ou déshumidification", () => {
    assert.equal(chambre({ chambre: { 7: "3", 177: "24.5" } }).setpoint, 24.5);
    assert.equal(chambre({ chambre: { 7: "8", 177: "24.5" } }).setpoint, 24.5);
  });

  it("n'a pas de consigne en ventilation seule", () => {
    assert.equal(chambre({ chambre: { 7: "7" } }).setpoint, null);
  });

  it("garde la dernière consigne chaud quand l'unité est arrêtée", () => {
    const room = salon();
    assert.equal(room.mode, "off");
    assert.equal(room.setpoint, 25);
  });

  it("ignore une température hors plage (unité arrêtée, capteur absent)", () => {
    assert.equal(salon().temperature, null);
  });

  it("ignore une température que l'unité déclare invalide", () => {
    assert.equal(chambre({ chambre: { 103150: "0" } }).temperature, null);
  });

  it("liste les modes autorisés par l'unité, et seulement eux", () => {
    assert.deepEqual(chambre().modes, ["off", "auto", "cool", "heat", "fan", "dry"]);
    assert.deepEqual(chambre({ chambre: { 166: "17" } }).modes, ["off", "heat"]);
  });

  it("donne les bornes et le pas de consigne selon le mode", () => {
    assert.deepEqual(chambre().setpointRange, { min: 16, max: 30, step: 0.5 });
    assert.deepEqual(chambre({ chambre: { 7: "3" } }).setpointRange, { min: 18, max: 30, step: 0.5 });
    // Auto : plage commune au chaud et au froid.
    assert.deepEqual(chambre({ chambre: { 7: "1" } }).setpointRange, { min: 18, max: 30, step: 0.5 });
  });

  it("lit la ventilation, le silence, les volets et les options", () => {
    const room = chambre({ chambre: { 100801: "2", 100802: "1", 100804: "1", 100505: "1" } });
    assert.equal(room.fan, "quiet"); // le silence l'emporte sur la vitesse
    assert.deepEqual(room.fanSpeeds, ["auto", "low", "medium", "high", "quiet"]);
    assert.equal(room.louver, "swing");
    assert.deepEqual(room.louvers, ["swing", "1", "2", "3", "4"]);
    assert.equal(room.powerful, true);
    assert.equal(room.economy, true);
  });

  it("lit une position de volet fixe, et ignore une position inexistante", () => {
    assert.equal(chambre().louver, "4");
    assert.equal(chambre({ chambre: { 100803: "6" } }).louver, null);
    assert.equal(chambre().fan, "auto");
  });

  it("restreint les vitesses à la séquence déclarée par l'unité", () => {
    assert.deepEqual(chambre({ chambre: { 100800: "1" } }).fanSpeeds, ["low", "high", "quiet"]);
  });

  it("n'expose pas un réglage absent de l'unité", () => {
    const setup = makeSetup();
    const room = setup.devices.find((d) => d.deviceId === 1001);
    room.capabilities = room.capabilities.filter((c) => ![100505, 100507, 100803, 100804].includes(c.capabilityId));
    const read = readRooms(setup).find((r) => r.id === 1001);
    assert.equal(read.powerful, undefined);
    assert.equal(read.economy, undefined);
    assert.equal(read.louvers, undefined);
  });

  it("signale une unité hors ligne", () => {
    assert.equal(salon({ salonAvailable: false }).available, false);
    assert.equal(chambre().available, true);
  });

  it("signale le programme hebdomadaire actif", () => {
    assert.equal(chambre().program.active, false);
    assert.equal(chambre({ chambre: { 184: "1" } }).program.active, true);
  });
});

describe("préparation des commandes", () => {
  const writes = (room, setting, value) => planCommand(room, setting, value);

  it("change de mode", () => {
    assert.deepEqual(writes(chambre(), "mode", "cool"), [{ capabilityId: 7, value: "3" }]);
    assert.deepEqual(writes(salon(), "mode", "heat"), [{ capabilityId: 7, value: "4" }]);
    assert.deepEqual(writes(chambre(), "mode", "off"), [{ capabilityId: 7, value: "0" }]);
  });

  it("refuse un mode que l'unité ne propose pas", () => {
    assert.throws(() => writes(chambre({ chambre: { 166: "17" } }), "mode", "cool"), CommandError);
    assert.throws(() => writes(chambre(), "mode", "turbo"), CommandError);
  });

  it("écrit la consigne chaud ou froid selon le mode", () => {
    assert.deepEqual(writes(chambre(), "setpoint", 21.5), [{ capabilityId: 40, value: "21.5" }]);
    assert.deepEqual(writes(chambre({ chambre: { 7: "3" } }), "setpoint", 24), [{ capabilityId: 177, value: "24" }]);
    assert.deepEqual(writes(chambre({ chambre: { 7: "8" } }), "setpoint", 24), [{ capabilityId: 177, value: "24" }]);
  });

  it("refuse une consigne hors bornes ou hors pas", () => {
    assert.throws(() => writes(chambre(), "setpoint", 15.5), CommandError);
    assert.throws(() => writes(chambre(), "setpoint", 30.5), CommandError);
    assert.throws(() => writes(chambre(), "setpoint", 21.3), CommandError);
    assert.throws(() => writes(chambre({ chambre: { 7: "3" } }), "setpoint", 17), CommandError);
    assert.throws(() => writes(chambre(), "setpoint", "21"), CommandError);
    assert.throws(() => writes(chambre(), "setpoint", Number.NaN), CommandError);
  });

  it("refuse une consigne quand l'unité est arrêtée ou en ventilation", () => {
    assert.throws(() => writes(salon(), "setpoint", 21), CommandError);
    assert.throws(() => writes(chambre({ chambre: { 7: "7" } }), "setpoint", 21), CommandError);
  });

  it("passe en dérogation (durée puis activation) avant de changer la consigne d'un programme actif", () => {
    const planned = writes(chambre({ chambre: { 184: "1" } }), "setpoint", 21);
    assert.deepEqual(
      planned.map((w) => w.capabilityId),
      [158, 157, 40],
    );
    assert.equal(planned[2].value, "21");
  });

  it("passe en dérogation sans durée si le programme n'a aucun créneau", () => {
    const empty = "[[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]]";
    const days = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [100320 + i, empty]));
    assert.deepEqual(writes(chambre({ chambre: { 184: "1", ...days } }), "setpoint", 21), [
      { capabilityId: 157, value: "1" },
      { capabilityId: 40, value: "21" },
    ]);
  });

  it("règle la vitesse et coupe le silence si besoin", () => {
    assert.deepEqual(writes(chambre(), "fan", "high"), [{ capabilityId: 100801, value: "3" }]);
    assert.deepEqual(writes(chambre({ chambre: { 100802: "1" } }), "fan", "low"), [
      { capabilityId: 100802, value: "0" },
      { capabilityId: 100801, value: "1" },
    ]);
    assert.deepEqual(writes(chambre(), "fan", "quiet"), [{ capabilityId: 100802, value: "1" }]);
  });

  it("refuse une vitesse hors séquence", () => {
    assert.throws(() => writes(chambre({ chambre: { 100800: "1" } }), "fan", "medium"), CommandError);
  });

  it("règle les volets : balayage ou position fixe", () => {
    assert.deepEqual(writes(chambre(), "louver", "swing"), [{ capabilityId: 100804, value: "1" }]);
    assert.deepEqual(writes(chambre({ chambre: { 100804: "1" } }), "louver", "2"), [
      { capabilityId: 100804, value: "0" },
      { capabilityId: 100803, value: "2" },
    ]);
    // Le Takao Plus n'a que 4 positions, malgré les 6 du catalogue Atlantic.
    assert.throws(() => writes(chambre(), "louver", "5"), CommandError);
    assert.throws(() => writes(chambre(), "louver", "6"), CommandError);
  });

  it("active ou coupe pleine puissance et économie", () => {
    assert.deepEqual(writes(chambre(), "powerful", true), [{ capabilityId: 100505, value: "1" }]);
    assert.deepEqual(writes(chambre(), "economy", false), [{ capabilityId: 100507, value: "0" }]);
    assert.throws(() => writes(chambre(), "economy", "non"), CommandError);
  });

  it("refuse un réglage inconnu ou absent de l'unité", () => {
    assert.throws(() => writes(chambre(), "turbo", true), CommandError);
    const setup = makeSetup();
    const device = setup.devices.find((d) => d.deviceId === 1001);
    device.capabilities = device.capabilities.filter((c) => c.capabilityId !== 100505);
    const room = readRooms(setup).find((r) => r.id === 1001);
    assert.throws(() => writes(room, "powerful", true), CommandError);
  });

  it("refuse toute commande vers une unité hors ligne", () => {
    assert.throws(() => writes(salon({ salonAvailable: false }), "mode", "heat"), CommandError);
  });
});
