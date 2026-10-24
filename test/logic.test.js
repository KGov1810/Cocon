// Logique d'affichage du tableau de bord (sans navigateur).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyOptimistic,
  canAdjust,
  conflictWith,
  daysFor,
  describeAbsence,
  describeRoom,
  describeNext,
  describeOutcome,
  formatClock,
  fillLevel,
  formatTemperature,
  isFlick,
  isRunning,
  optionsSummary,
  powerOnMode,
  rubberBand,
  setpointFromDrag,
  shownStatus,
  splitTemperature,
  validateDraft,
  waveLevel,
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

/* ---------- Phase 3 : programme et absence ---------- */


describe("programme : affichage", () => {
  it("écrit une heure au format 24 h", () => {
    assert.equal(formatClock(360), "06:00");
    assert.equal(formatClock(1335), "22:15");
  });

  it("décrit le prochain changement, aujourd'hui, demain ou un autre jour", () => {
    assert.equal(describeNext({ day: 2, minutes: 1320, setpoint: 19, off: false }, 2), "19° à 22:00");
    assert.equal(describeNext({ day: 3, minutes: 360, setpoint: 20, off: false }, 2), "20° demain à 06:00");
    assert.equal(describeNext({ day: 0, minutes: 360, setpoint: 20, off: false }, 2), "20° lundi à 06:00");
    assert.equal(describeNext({ day: 2, minutes: 1380, setpoint: null, off: true }, 2), "arrêt à 23:00");
    assert.equal(describeNext({ day: 6, minutes: 0, setpoint: null, off: true }, 5), "arrêt demain à 00:00");
  });

  it("donne les jours visés par « appliquer à »", () => {
    assert.deepEqual(daysFor("day", 3), [3]);
    assert.deepEqual(daysFor("weekdays", 6), [0, 1, 2, 3, 4]);
    assert.deepEqual(daysFor("weekend", 0), [5, 6]);
    assert.deepEqual(daysFor("week", 2), [0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("programme : vérification avant envoi", () => {
  const limits = { step: 15, minGap: 60, maxPerDay: 8, minPerWeek: 1 };
  const slot = (minutes, setpoint = 20) => ({ minutes, setpoint, off: false });

  it("accepte un jour valide", () => {
    assert.equal(validateDraft([slot(360), slot(1320, 19)], limits, 0), null);
  });

  it("refuse deux changements à moins d'une heure d'écart", () => {
    assert.match(validateDraft([slot(360), slot(390)], limits, 0), /au moins 60 min/);
  });

  it("refuse deux changements à la même heure", () => {
    assert.match(validateDraft([slot(360), slot(360)], limits, 0), /au moins 60 min/);
  });

  it("refuse plus de changements que l'unité n'en accepte", () => {
    const many = Array.from({ length: 9 }, (_, i) => slot(i * 120));
    assert.match(validateDraft(many, limits, 0), /Au plus 8/);
  });

  it("refuse une semaine sans aucun changement", () => {
    assert.match(validateDraft([], limits, 0), /au moins un changement/);
    assert.equal(validateDraft([], limits, 2), null);
  });
});

describe("absence : affichage", () => {
  // 30 octobre 2026, 18 h 00, heure de Paris.
  const end = Date.UTC(2026, 9, 30, 17, 0) / 1000;
  const start = Date.UTC(2026, 9, 24, 7, 30) / 1000;

  it("décrit une absence en cours", () => {
    assert.equal(
      describeAbsence({ status: "on", start, end }, "Europe/Paris"),
      "Absence en cours jusqu'au ven. 30 oct. à 18:00",
    );
  });

  it("décrit une absence programmée", () => {
    assert.equal(
      describeAbsence({ status: "scheduled", start, end }, "Europe/Paris"),
      "Absence programmée du sam. 24 oct. à 09:30 au ven. 30 oct. à 18:00",
    );
  });

  it("ne dit rien sans absence", () => {
    assert.equal(describeAbsence({ status: "off", start: null, end: null }, "Europe/Paris"), null);
  });
});

/* ---------- Écran d'une pièce : chiffre, niveau, vague et gestes ---------- */

describe("écran : le grand chiffre", () => {
  it("sépare l'entier et la décimale", () => {
    assert.deepEqual(splitTemperature(21.5), { whole: "21", decimal: ",5" });
  });

  it("n'affiche pas de décimale pour un nombre rond", () => {
    assert.deepEqual(splitTemperature(21), { whole: "21", decimal: "" });
  });

  it("affiche un tiret sans valeur", () => {
    assert.deepEqual(splitTemperature(null), { whole: "—", decimal: "" });
  });
});

describe("écran : le niveau monte avec la consigne", () => {
  it("part de 12 % au minimum et va jusqu'à 82 % au maximum", () => {
    assert.equal(fillLevel(room({ setpoint: 16 })), 0.12);
    assert.equal(fillLevel(room({ setpoint: 30 })), 0.82);
    assert.equal(fillLevel(room({ setpoint: 23 })), 0.47);
  });

  it("reste dans l'écran même si la consigne sort des bornes du mode", () => {
    assert.equal(fillLevel(room({ setpoint: 31 })), 0.82);
    assert.equal(fillLevel(room({ setpoint: 10 })), 0.12);
  });

  it("reste au plus bas sans consigne (ventilation, arrêt inconnu)", () => {
    assert.equal(fillLevel(room({ mode: "fan", setpoint: null, setpointRange: null })), 0.12);
  });
});

describe("écran : force estimée de la vague", () => {
  it("est nulle à l'arrêt, en état inconnu ou hors ligne", () => {
    assert.equal(waveLevel(room({ mode: "off" })), 0);
    assert.equal(waveLevel(room({ mode: "unknown" })), 0);
    assert.equal(waveLevel(room({ available: false })), 0);
  });

  it("suit l'écart à combler dans le sens du mode, en ventilation auto", () => {
    assert.equal(waveLevel(room({ mode: "heat", setpoint: 22, temperature: 20 })), 0.65);
    assert.equal(waveLevel(room({ mode: "heat", setpoint: 20, temperature: 22 })), 0.25);
    assert.equal(waveLevel(room({ mode: "cool", setpoint: 24, temperature: 26 })), 0.65);
  });

  it("suit l'écart dans les deux sens en mode auto", () => {
    assert.equal(waveLevel(room({ mode: "auto", setpoint: 20, temperature: 22 })), 0.65);
    assert.equal(waveLevel(room({ mode: "auto", setpoint: 24, temperature: 22 })), 0.65);
  });

  it("suit la vitesse choisie quand elle est fixée", () => {
    assert.equal(waveLevel(room({ fan: "quiet", temperature: 18 })), 0.25);
    assert.equal(waveLevel(room({ fan: "high", temperature: 18 })), 0.85);
  });

  it("est au maximum en pleine puissance et réduite en économie", () => {
    assert.equal(waveLevel(room({ powerful: true, temperature: 21 })), 1);
    assert.equal(waveLevel(room({ fan: "high", economy: true, temperature: 18 })), 0.6375);
  });

  it("reste moyenne quand la température de la pièce est inconnue", () => {
    assert.equal(waveLevel(room({ temperature: null })), 0.4);
  });

  it("ne dépasse jamais 1", () => {
    assert.equal(waveLevel(room({ mode: "heat", setpoint: 30, temperature: 10 })), 1);
  });
});

describe("écran : glisser pour régler la consigne", () => {
  it("monte d'un pas tous les 22 px vers le haut", () => {
    assert.deepEqual(setpointFromDrag(room(), 21, 44), { value: 22, overshoot: 0 });
    assert.deepEqual(setpointFromDrag(room(), 21, -22), { value: 20.5, overshoot: 0 });
  });

  it("arrondit au pas le plus proche", () => {
    assert.equal(setpointFromDrag(room(), 21, 30).value, 21.5);
    assert.equal(setpointFromDrag(room(), 21, 10).value, 21);
  });

  it("s'arrête aux bornes et mesure le dépassement en pixels", () => {
    assert.deepEqual(setpointFromDrag(room(), 29, 88), { value: 30, overshoot: 44 });
    assert.deepEqual(setpointFromDrag(room(), 17, -66), { value: 16, overshoot: -22 });
  });

  it("respecte les bornes propres au mode froid", () => {
    const cool = room({ mode: "cool", setpointRange: { min: 18, max: 30, step: 0.5 } });
    assert.equal(setpointFromDrag(cool, 18.5, -44).value, 18);
  });

  it("ne règle rien sans consigne", () => {
    assert.equal(setpointFromDrag(room({ setpoint: null, setpointRange: null }), null, 44), null);
  });
});

describe("écran : gestes", () => {
  it("freine de plus en plus au-delà d'une borne, sans jamais s'arrêter net", () => {
    assert.equal(rubberBand(0, 280), 0);
    const near = rubberBand(20, 280);
    const far = rubberBand(400, 280);
    assert.ok(near > 0 && near < 20);
    assert.ok(far > near && far < 0.55 * 280);
    assert.equal(rubberBand(-20, 280), -near);
  });

  it("change de pièce sur un geste ample ou un coup sec", () => {
    assert.equal(isFlick(-80, 600), true);
    assert.equal(isFlick(30, 80), true);
    assert.equal(isFlick(30, 400), false);
    assert.equal(isFlick(10, 20), false);
  });
});

describe("écran : résumé des options", () => {
  it("nomme les options actives", () => {
    assert.equal(optionsSummary(room({ powerful: false, economy: true })), "Économie");
    assert.equal(optionsSummary(room({ powerful: true, economy: false })), "Puissance");
    assert.equal(optionsSummary(room({ powerful: true, economy: true })), "Puissance + éco");
    assert.equal(optionsSummary(room({ powerful: false, economy: false })), "Aucune");
  });

  it("n'a pas de tuile si l'unité n'a aucune de ces options", () => {
    assert.equal(optionsSummary(room()), null);
  });
});

describe("écran : état de la pièce", () => {
  it("distingue une pièce qui tourne d'une pièce arrêtée, inconnue ou hors ligne", () => {
    assert.equal(isRunning(room()), true);
    assert.equal(isRunning(room({ mode: "off" })), false);
    assert.equal(isRunning(room({ mode: "unknown" })), false);
    assert.equal(isRunning(room({ available: false })), false);
  });

  it("ne laisse régler la consigne au doigt que si elle existe dans ce mode", () => {
    assert.equal(canAdjust(room()), true);
    assert.equal(canAdjust(room({ mode: "dry" })), true);
    assert.equal(canAdjust(room({ mode: "off" })), false);
    assert.equal(canAdjust(room({ mode: "fan", setpoint: null, setpointRange: null })), false);
    assert.equal(canAdjust(room({ mode: "fan" })), false); // même si une consigne traîne
    assert.equal(canAdjust(room({ available: false })), false);
  });

  it("dit si l'unité chauffe encore ou si la consigne est atteinte", () => {
    assert.equal(describeRoom(room({ temperature: 19 }), {}), "Chauffe pour atteindre la consigne");
    assert.equal(describeRoom(room({ temperature: 21 }), {}), "Consigne atteinte, l'unité ralentit");
    assert.equal(describeRoom(room({ mode: "cool", setpoint: 24, temperature: 26 }), {}), "Refroidit pour atteindre la consigne");
    assert.equal(describeRoom(room({ mode: "cool", setpoint: 24, temperature: 23 }), {}), "Consigne atteinte, l'unité ralentit");
    assert.equal(describeRoom(room({ mode: "cool", setpoint: 24, temperature: 24 }), {}), "Consigne atteinte, l'unité ralentit");
  });

  it("annonce le mode de rallumage d'une pièce arrêtée", () => {
    assert.equal(describeRoom(room({ mode: "off" }), { onMode: "heat" }), "À l'arrêt · se rallumera en chauffage");
    assert.equal(describeRoom(room({ mode: "off" }), {}), "À l'arrêt");
  });

  it("donne la priorité à la panne puis à l'absence", () => {
    assert.equal(describeRoom(room({ available: false }), { absent: true }), "Unité injoignable : vérifiez le hub Cozytouch.");
    assert.equal(describeRoom(room(), { absent: true }), "Arrêtée pendant l'absence");
  });
});

describe("écran : retour de commande", () => {
  it("garde l'envoi et la saisie en cours affichés, puis efface le résultat après 45 s", () => {
    const at = 1_000_000;
    assert.equal(shownStatus(null, at), null);
    assert.equal(shownStatus(undefined, at), null); // pièce sans commande récente (Map.get)
    assert.deepEqual(shownStatus({ kind: "sending", text: "…", at }, at + 120_000), { kind: "sending", text: "…", at });
    assert.equal(shownStatus({ kind: "draft", text: "…", at }, at + 120_000).kind, "draft");
    assert.equal(shownStatus({ kind: "ok", text: "Confirmé", at }, at + 44_999).kind, "ok");
    assert.equal(shownStatus({ kind: "ok", text: "Confirmé", at }, at + 45_000), null);
  });
});
