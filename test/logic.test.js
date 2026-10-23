// Logique d'affichage du tableau de bord (sans navigateur).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyOptimistic,
  conflictWith,
  describeOutcome,
  formatTemperature,
  powerOnMode,
  stepSetpoint,
} from "../public/assets/logic.js";

const room = (overrides = {}) => ({
  id: 1,
  name: "Chambre",
  available: true,
  mode: "heat",
  modes: ["off", "auto", "cool", "heat", "fan", "dry"],
  setpoint: 21,
  setpointRange: { min: 16, max: 30, step: 0.5 },
  fan: "auto",
  ...overrides,
});

describe("formats", () => {
  it("écrit les températures à la française", () => {
    assert.equal(formatTemperature(21.5), "21,5°");
    assert.equal(formatTemperature(26), "26°");
    assert.equal(formatTemperature(22.25), "22,3°");
    assert.equal(formatTemperature(null), "—");
  });

  it("décrit le résultat d'une commande avec sa durée", () => {
    assert.equal(describeOutcome({ status: "confirmed", elapsedMs: 2400 }), "Confirmé par Atlantic en 2,4 s");
    assert.equal(describeOutcome({ status: "confirmed", elapsedMs: 61_000 }), "Confirmé par Atlantic en 1 min 1 s");
    assert.equal(
      describeOutcome({ status: "pending", elapsedMs: 9000 }),
      "Envoyé. Atlantic n'a pas encore confirmé, l'affichage se mettra à jour.",
    );
  });
});

describe("consigne", () => {
  it("avance d'un pas dans les bornes", () => {
    assert.equal(stepSetpoint(room(), +1), 21.5);
    assert.equal(stepSetpoint(room(), -1), 20.5);
  });

  it("reste dans les bornes", () => {
    assert.equal(stepSetpoint(room({ setpoint: 30 }), +1), 30);
    assert.equal(stepSetpoint(room({ setpoint: 16 }), -1), 16);
  });

  it("n'a pas de consigne sans plage (ventilation)", () => {
    assert.equal(stepSetpoint(room({ mode: "fan", setpoint: null, setpointRange: null }), +1), null);
  });
});

describe("multi-split", () => {
  const salon = (mode) => room({ id: 2, name: "Salon", mode });

  it("signale un mode opposé dans l'autre pièce", () => {
    assert.equal(conflictWith([room(), salon("cool")], 1, "heat")?.name, "Salon");
    assert.equal(conflictWith([room(), salon("heat")], 1, "cool")?.name, "Salon");
    assert.equal(conflictWith([room(), salon("heat")], 1, "dry")?.name, "Salon");
  });

  it("ne signale rien si l'autre pièce est arrêtée, compatible ou hors ligne", () => {
    assert.equal(conflictWith([room(), salon("off")], 1, "cool"), null);
    assert.equal(conflictWith([room(), salon("heat")], 1, "heat"), null);
    assert.equal(conflictWith([room(), salon("fan")], 1, "cool"), null);
    assert.equal(conflictWith([room(), { ...salon("heat"), available: false }], 1, "cool"), null);
  });
});

describe("rallumage", () => {
  it("reprend le dernier mode utilisé s'il est disponible", () => {
    assert.equal(powerOnMode(room({ mode: "off" }), "cool", 6), "cool");
  });

  it("choisit le chauffage d'octobre à avril, le froid sinon", () => {
    assert.equal(powerOnMode(room({ mode: "off" }), null, 9), "heat"); // octobre
    assert.equal(powerOnMode(room({ mode: "off" }), null, 3), "heat"); // avril
    assert.equal(powerOnMode(room({ mode: "off" }), null, 6), "cool"); // juillet
  });

  it("ignore un mode mémorisé que l'unité ne propose pas", () => {
    assert.equal(powerOnMode(room({ mode: "off", modes: ["off", "heat"] }), "cool", 6), "heat");
    assert.equal(powerOnMode(room({ mode: "off" }), "off", 9), "heat");
  });
});

describe("valeurs affichées avant confirmation", () => {
  it("affiche la valeur demandée tant qu'Atlantic renvoie l'ancienne", () => {
    const optimistic = new Map([[1, { setpoint: { value: 23, until: 10_000 } }]]);
    const result = applyOptimistic([room({ setpoint: 21 })], optimistic, 5_000);
    assert.equal(result.rooms[0].setpoint, 23);
    assert.ok(result.optimistic.get(1).setpoint);
  });

  it("oublie la valeur demandée dès qu'Atlantic la confirme", () => {
    const optimistic = new Map([[1, { setpoint: { value: 23, until: 10_000 } }]]);
    const result = applyOptimistic([room({ setpoint: 23 })], optimistic, 5_000);
    assert.equal(result.rooms[0].setpoint, 23);
    assert.equal(result.optimistic.has(1), false);
  });

  it("revient à l'état réel quand le délai d'attente est passé", () => {
    const optimistic = new Map([[1, { setpoint: { value: 23, until: 10_000 } }]]);
    const result = applyOptimistic([room({ setpoint: 21 })], optimistic, 10_001);
    assert.equal(result.rooms[0].setpoint, 21);
    assert.equal(result.optimistic.has(1), false);
  });

  it("ne modifie pas les objets reçus", () => {
    const original = room({ setpoint: 21 });
    applyOptimistic([original], new Map([[1, { setpoint: { value: 23, until: 10_000 } }]]), 0);
    assert.equal(original.setpoint, 21);
  });
});
