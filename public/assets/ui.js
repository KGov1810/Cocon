/**
 * Éléments d'interface partagés : icônes, choix (« chips ») et interrupteurs.
 * Tout est construit avec le DOM, jamais à partir de HTML.
 */

import { el } from "./api.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Icônes : tracés simples dessinés pour Cocon (24 × 24, trait de 2). */
const ICONS = {
  minus: "M5 12h14",
  plus: "M12 5v14M5 12h14",
  power: "M12 3v8M7.1 6.3a7.5 7.5 0 1 0 9.8 0",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  back: "M15 18l-6-6 6-6",
  remove: "M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M10 7V4h4v3",
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", name === "more" ? "3.2" : "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

/** Bouton de choix ; `pressed` indique le choix actuel. */
export function chip(label, { pressed, disabled, onclick, confirm, ariaLabel }) {
  return el(
    "button",
    {
      class: "chip",
      type: "button",
      "aria-pressed": pressed ? "true" : "false",
      "aria-label": ariaLabel ?? null,
      "data-confirm": confirm || null,
      disabled,
      onclick,
    },
    label,
  );
}

let optionCount = 0;

/** Ligne « libellé + explication + interrupteur ». */
export function option(label, help, checked, disabled, onclick) {
  optionCount += 1;
  const id = `option-${optionCount}`;
  return el("div", { class: "option" }, [
    el("div", { class: "option__text" }, [
      el("span", { class: "option__label", id }, label),
      el("span", { class: "option__help" }, help),
    ]),
    el("button", {
      class: "switch",
      type: "button",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      "aria-labelledby": id,
      disabled,
      onclick,
    }),
  ]);
}
