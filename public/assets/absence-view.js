/**
 * Mode Absence côté interface : bandeau d'état et fiche de programmation.
 * Les dates sont saisies à l'heure du téléphone et envoyées en secondes Unix.
 */

import { el } from "./api.js";
import { describeAbsence } from "./logic.js";
import { chip } from "./ui.js";

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Valeur d'un champ datetime-local (« 2026-10-30T18:00 ») pour une date. */
function inputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Secondes Unix d'un champ datetime-local (lu à l'heure du téléphone) ; null si vide. */
function inputSeconds(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Texte du bandeau ; null s'il n'y a pas d'absence. */
export function absenceText(absence) {
  return describeAbsence(absence, TIME_ZONE);
}

/** Formulaire vide : départ maintenant, retour demain à 18 h. */
export function newAbsenceForm() {
  const back = new Date();
  back.setDate(back.getDate() + 1);
  back.setHours(18, 0, 0, 0);
  return { when: "now", start: inputValue(new Date(Date.now() + 3600_000)), end: inputValue(back) };
}

/**
 * Contenu de la fiche Absence.
 * @returns {{ head: HTMLElement, body: (HTMLElement|null)[] }}
 */
export function absenceView(absence, form, { busy, status, onChange, onSubmit, onCancelAbsence, onClose }) {
  const current = absenceText(absence);
  const start = form.when === "now" ? Math.floor(Date.now() / 1000) : inputSeconds(form.start);
  const end = inputSeconds(form.end);
  let error = null;
  if (end === null || (form.when === "later" && start === null)) error = "Indiquez les dates.";
  else if (end - start < 15 * 60) error = "Le retour doit suivre le départ d'au moins 15 minutes.";

  const field = (id, label, value, key) =>
    el("div", { class: "field" }, [
      el("label", { for: id }, label),
      el("input", {
        id,
        type: "datetime-local",
        value,
        disabled: busy,
        // « change » et non « input » : sur iPhone, le sélecteur de date reste ouvert pendant le choix.
        onchange: (e) => onChange({ [key]: e.target.value }),
      }),
    ]);

  const head = el("div", { class: "sheet__head" }, [
    el("h2", { id: "absence-title" }, "Absence"),
    el("span", { class: "spacer" }),
    el("button", { class: "button button--quiet", type: "button", onclick: onClose }, "Fermer"),
  ]);

  const body = [
    el(
      "p",
      { class: "group__help" },
      "Pour toute la maison : les climatiseurs s'arrêtent pendant l'absence et reprennent leur mode au retour.",
    ),
    current
      ? el("div", { class: "stack stack--tight" }, [
          el("p", { class: "notice" }, current),
          el(
            "button",
            { class: "button", type: "button", disabled: busy, onclick: onCancelAbsence },
            "Annuler l'absence",
          ),
        ])
      : null,
    el("section", { class: "group" }, [
      el("h3", {}, current ? "Remplacer par une nouvelle absence" : "Programmer une absence"),
      el("div", { class: "chips", role: "group", "aria-label": "Départ" }, [
        chip("Départ maintenant", { pressed: form.when === "now", disabled: busy, onclick: () => onChange({ when: "now" }) }),
        chip("Départ plus tard", { pressed: form.when === "later", disabled: busy, onclick: () => onChange({ when: "later" }) }),
      ]),
    ]),
    form.when === "later" ? field("absence-start", "Départ", form.start, "start") : null,
    field("absence-end", "Retour", form.end, "end"),
    error ? el("p", { class: "warning", role: "alert" }, error) : null,
    status,
    el(
      "button",
      {
        class: "button button--primary",
        type: "button",
        disabled: busy || Boolean(error),
        onclick: () => onSubmit({ start, end }),
      },
      "Programmer l'absence",
    ),
  ];
  return { head, body };
}
