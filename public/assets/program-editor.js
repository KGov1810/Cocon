/**
 * Programme hebdomadaire côté interface :
 * - programLine() : la ligne affichée sur le panneau d'une pièce ;
 * - programGroup() : le groupe « Programme » de la fiche de réglages ;
 * - editorView() : l'éditeur jour par jour (créneaux, copie vers d'autres jours).
 *
 * L'état de l'éditeur vit dans app.js ; ce module ne fait qu'afficher et
 * signaler les changements par des fonctions de rappel.
 */

import { el } from "./api.js";
import { daysFor, describeNext, formatClock, formatTemperature, validateDraft } from "./logic.js";
import { chip, icon, option } from "./ui.js";

const DAY_SHORT = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const DAY_LONG = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const KIND_LABEL = { heat: "Chauffage", cool: "Froid" };
const APPLY_TO = [
  ["day", "Ce jour"],
  ["weekdays", "Lun–ven"],
  ["weekend", "Sam–dim"],
  ["week", "Toute la semaine"],
];

/** Jour de la semaine sur ce téléphone, 0 = lundi. */
export function todayIndex(date = new Date()) {
  return (date.getDay() + 6) % 7;
}

/** Programme suivi dans le mode actuel de la pièce. */
export function kindFor(room) {
  if (room.mode === "cool" || room.mode === "dry") return room.program?.cool ? "cool" : "heat";
  return room.program?.heat ? "heat" : "cool";
}

/** Ligne du panneau : prochain changement, ou dérogation en cours ; null si inactif. */
export function programLine(room) {
  const program = room.program;
  if (!program?.active) return null;
  const next = program.next ? describeNext(program.next, todayIndex()) : null;
  if (program.override.active) {
    return next ? `Consigne modifiée à la main, le programme reprend : ${next}` : "Consigne modifiée à la main";
  }
  return next ? `Programme : ${next}` : "Programme actif";
}

function daySummary(slots) {
  if (!slots.length) return "aucun changement";
  return slots.map((s) => `${formatClock(s.minutes)} ${s.off ? "arrêt" : formatTemperature(s.setpoint)}`).join(", ");
}

/** Groupe « Programme » de la fiche de réglages. */
export function programGroup(room, { busy, onToggle, onEdit }) {
  const program = room.program;
  const kind = kindFor(room);
  return el("section", { class: "group" }, [
    el("h3", {}, "Programme"),
    option(
      "Suivre le programme",
      "Les changements prévus s'appliquent tout seuls, même téléphone éteint.",
      program.active,
      busy,
      () => onToggle(!program.active),
    ),
    el(
      "p",
      { class: "group__help" },
      `${KIND_LABEL[kind]}, aujourd'hui : ${daySummary(program[kind][todayIndex()])}.`,
    ),
    el("button", { class: "button program__edit", type: "button", disabled: busy, onclick: onEdit }, "Modifier le programme"),
  ]);
}

/** Nouvel éditeur pour une pièce, positionné sur aujourd'hui et le mode en cours. */
export function openEditor(room) {
  const kind = kindFor(room);
  const day = todayIndex();
  return { roomId: room.id, kind, day, slots: structuredClone(room.program[kind][day]), applyTo: "day", dirty: false };
}

/** Recharge l'éditeur depuis l'état reçu (après un changement de jour ou un enregistrement). */
export function reloadEditor(room, editor, patch = {}) {
  const next = { ...editor, ...patch };
  return { ...next, slots: structuredClone(room.program[next.kind][next.day]), dirty: false };
}

function newSlot(slots, kind, program, ranges) {
  const last = slots.at(-1);
  const minutes = last ? Math.min(last.minutes + 120, 1440 - program.limits.step) : 360;
  const preferred = kind === "cool" ? 24 : 20;
  const setpoint = Math.min(ranges[kind].max, Math.max(ranges[kind].min, preferred));
  return { minutes, setpoint, off: false };
}

function select(label, value, values, onchange, disabled) {
  return el(
    "select",
    { class: "time__part", "aria-label": label, disabled, onchange: (e) => onchange(Number(e.target.value)) },
    values.map(([v, text]) => {
      const node = el("option", { value: String(v) }, text);
      node.selected = v === value;
      return node;
    }),
  );
}

function slotRow(slot, index, ctx) {
  const { program, kind, busy, update } = ctx;
  const range = program.ranges[kind];
  const hours = Math.floor(slot.minutes / 60);
  const minutes = slot.minutes % 60;
  const minuteChoices = [];
  for (let m = 0; m < 60; m += program.limits.step) minuteChoices.push([m, String(m).padStart(2, "0")]);

  const setSlot = (patch) => update(index, { ...slot, ...patch });
  const time = el("div", { class: "time" }, [
    select(
      "Heure",
      hours,
      Array.from({ length: 24 }, (_, h) => [h, String(h).padStart(2, "0")]),
      (h) => setSlot({ minutes: h * 60 + minutes }),
      busy,
    ),
    el("span", { "aria-hidden": "true" }, ":"),
    select("Minutes", minutes, minuteChoices, (m) => setSlot({ minutes: hours * 60 + m }), busy),
  ]);

  const value = slot.off
    ? el("span", { class: "slot__off" }, "Arrêt")
    : el("div", { class: "slot__stepper" }, [
        el(
          "button",
          {
            class: "round round--small",
            type: "button",
            "aria-label": "Baisser",
            disabled: busy || slot.setpoint <= range.min,
            onclick: () => setSlot({ setpoint: slot.setpoint - 1 }),
          },
          icon("minus"),
        ),
        el("span", { class: "slot__value" }, formatTemperature(slot.setpoint)),
        el(
          "button",
          {
            class: "round round--small",
            type: "button",
            "aria-label": "Monter",
            disabled: busy || slot.setpoint >= range.max,
            onclick: () => setSlot({ setpoint: slot.setpoint + 1 }),
          },
          icon("plus"),
        ),
      ]);

  const toggleOff = program.offAvailable
    ? chip(slot.off ? "Température" : "Arrêt", {
        pressed: false,
        disabled: busy,
        ariaLabel: slot.off ? "Remplacer l'arrêt par une température" : "Remplacer par un arrêt",
        onclick: () =>
          setSlot(slot.off ? { off: false, setpoint: kind === "cool" ? 24 : 20 } : { off: true, setpoint: null }),
      })
    : null;

  return el("li", { class: "slot" }, [
    time,
    value,
    el("div", { class: "slot__actions" }, [
      toggleOff,
      el(
        "button",
        { class: "icon-button", type: "button", "aria-label": `Supprimer le changement de ${formatClock(slot.minutes)}`, disabled: busy, onclick: () => ctx.remove(index) },
        icon("remove"),
      ),
    ]),
  ]);
}

/**
 * Vue de l'éditeur dans la fiche.
 * @returns {{ head: HTMLElement, body: HTMLElement[] }}
 */
export function editorView(room, editor, { busy, status, onChange, onSave, onCancel, onBack }) {
  const program = room.program;
  const { kind, day, slots, applyTo, dirty } = editor;
  const targetDays = daysFor(applyTo, day);
  const otherSlots = program[kind].reduce((sum, d, i) => sum + (targetDays.includes(i) ? 0 : d.length), 0);
  const error = validateDraft(slots, program.limits, otherSlots);

  const setSlots = (next) => onChange({ slots: [...next].sort((a, b) => a.minutes - b.minutes), dirty: true });
  const ctx = {
    program,
    kind,
    busy,
    update: (index, slot) => setSlots(slots.map((s, i) => (i === index ? slot : s))),
    remove: (index) => setSlots(slots.filter((_, i) => i !== index)),
  };

  const kinds = ["heat", "cool"].filter((k) => program[k]);
  const head = el("div", { class: "sheet__head" }, [
    el("button", { class: "icon-button", type: "button", "aria-label": "Retour aux réglages", onclick: onBack }, icon("back")),
    el("h2", { id: "sheet-title" }, `Programme, ${room.name}`),
  ]);

  const locked = busy || dirty; // on n'abandonne pas des modifications en changeant de jour
  const body = [
    program.active
      ? null
      : el("p", { class: "warning" }, "Ce programme n'est pas suivi. Activez « Suivre le programme » pour qu'il s'applique."),
    kinds.length > 1
      ? el(
          "div",
          { class: "chips", role: "group", "aria-label": "Programme" },
          kinds.map((k) => chip(KIND_LABEL[k], { pressed: kind === k, disabled: locked, onclick: () => onChange({ kind: k }, true) })),
        )
      : null,
    el(
      "div",
      { class: "chips chips--days", role: "group", "aria-label": "Jour" },
      DAY_SHORT.map((label, i) =>
        chip(label, { pressed: day === i, disabled: locked, ariaLabel: DAY_LONG[i], onclick: () => onChange({ day: i }, true) }),
      ),
    ),
    dirty ? el("p", { class: "group__help" }, "Enregistrez ou annulez pour changer de jour.") : null,
    el("section", { class: "group" }, [
      el("h3", {}, `Changements du ${DAY_LONG[day]}`),
      slots.length
        ? el("ol", { class: "slots" }, slots.map((slot, i) => slotRow(slot, i, ctx)))
        : el("p", { class: "group__help" }, "Aucun changement : la consigne du jour précédent continue."),
      el(
        "button",
        {
          class: "button program__add",
          type: "button",
          disabled: busy || slots.length >= program.limits.maxPerDay,
          onclick: () => setSlots([...slots, newSlot(slots, kind, program, program.ranges)]),
        },
        [icon("plus"), "Ajouter un changement"],
      ),
      el(
        "p",
        { class: "group__help" },
        `Au plus ${program.limits.maxPerDay} par jour, au quart d'heure, avec ${program.limits.minGap} min d'écart. Températures en degrés entiers.`,
      ),
    ]),
    el("section", { class: "group" }, [
      el("h3", {}, "Appliquer à"),
      el(
        "div",
        { class: "chips" },
        APPLY_TO.map(([value, label]) =>
          chip(label, { pressed: applyTo === value, disabled: busy, onclick: () => onChange({ applyTo: value, dirty: true }) }),
        ),
      ),
    ]),
    error ? el("p", { class: "warning", role: "alert" }, error) : null,
    status,
    el("div", { class: "actions" }, [
      el(
        "button",
        {
          class: "button button--primary",
          type: "button",
          disabled: busy || !dirty || Boolean(error),
          onclick: () => onSave({ kind, days: targetDays, slots }),
        },
        "Enregistrer",
      ),
      dirty ? el("button", { class: "button", type: "button", disabled: busy, onclick: onCancel }, "Annuler") : null,
    ]),
  ];
  return { head, body };
}
