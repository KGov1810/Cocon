/**
 * Éléments d'interface partagés : icônes, choix (« chips »), interrupteurs et
 * pièces communes des panneaux (poignée, en-tête, ligne d'état, fermeture).
 * Tout est construit avec le DOM, jamais à partir de HTML.
 */

import { el } from "./api.js";
import { rubberBand } from "./logic.js";

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
  // Modes
  heat: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  cool: "M12 2v20M3.3 7l17.4 10M3.3 17l17.4-10M9 4l3 2 3-2M9 20l3-2 3 2",
  auto: "M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4M9.5 15l2.5-6 2.5 6M10.4 13h3.2",
  dry: "M12 3c3.5 4.5 6 7.6 6 10.5a6 6 0 0 1-12 0c0-2.9 2.5-6 6-10.5z",
  fan: "M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h7",
  off: "M12 3v8M7.1 6.3a7.5 7.5 0 1 0 9.8 0",
  // Vitesse
  speed: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 10c0-4 1-7 4-7 2 0 3 2 1 4l-3 3M14 12c4 0 7 1 7 4 0 2-2 3-4 1l-3-3M12 14c0 4-1 7-4 7-2 0-3-2-1-4l3-3M10 12c-4 0-7-1-7-4 0-2 2-3 4-1l3 3",
  quiet: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  low: "M6 18v-3",
  medium: "M6 18v-3M12 18v-7",
  high: "M6 18v-3M12 18v-7M18 18V6",
  // Volets
  swing: "M5 6h14M8 10l9 3M8 10l4 10",
  louver1: "M5 6h14M7 10l12 2",
  louver2: "M5 6h14M7 10l11 5",
  louver3: "M5 6h14M7 10l9 8",
  louver4: "M5 6h14M7 10l5 10",
  // Options, programme, absence
  boost: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
  eco: "M5 19c0-8 5-13 14-14-1 9-6 14-14 14zM5 19l7-7",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v5M16 3v5",
  clock: "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 8v4l3 2",
  bag: "M4 8h16v11H4zM9 8V5h6v3M4 13h16",
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

/**
 * Bouton de choix ; `pressed` indique le choix actuel. Avec `iconName`, l'icône
 * s'affiche au-dessus du libellé (grands choix des panneaux), et `tone` colore
 * le choix actif (couleur du mode).
 */
export function chip(label, { pressed, disabled, onclick, confirm, ariaLabel, iconName, tone }) {
  return el(
    "button",
    {
      class: iconName ? "chip chip--large" : "chip",
      type: "button",
      "aria-pressed": pressed ? "true" : "false",
      "aria-label": ariaLabel ?? null,
      "data-confirm": confirm || null,
      "data-tone": tone ?? null,
      disabled,
      onclick,
    },
    iconName ? [icon(iconName), el("span", {}, label)] : label,
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

/* ---------- Panneaux ---------- */

export const sheetGrab = () => el("div", { class: "sheet__grab", "aria-hidden": "true" });

/** En-tête « titre + Fermer » ; `id` sert d'étiquette au dialogue (aria-labelledby). */
export function sheetHead(id, title, onClose) {
  return el("div", { class: "sheet__head" }, [
    el("h2", { id }, title),
    el("span", { class: "spacer" }),
    el("button", { class: "button button--quiet", type: "button", onclick: onClose }, "Fermer"),
  ]);
}

/** Ligne d'état d'un panneau : roue pendant l'envoi, puis le résultat ; `fallback` sans envoi. */
export function sheetStatus(status, fallback = null) {
  const text = status?.text ?? fallback;
  const waiting = status?.kind === "sending" || status?.kind === "draft";
  return el("p", { class: "sheet__status", "aria-live": "polite", "data-kind": status?.kind ?? "", hidden: !text }, [
    waiting ? el("span", { class: "spinner", "aria-hidden": "true" }) : null,
    text,
  ]);
}

/**
 * Fermeture d'un panneau : toucher le fond assombri, ou tirer la poignée (ou
 * l'en-tête) vers le bas. Un geste ample ou un coup sec suffit.
 */
export function enableSheetDismiss(dialog) {
  let pull = null;
  let pulled = false; // un geste vient d'avoir lieu : le « click » qui suit ne compte pas

  dialog.addEventListener("click", (event) => {
    if (pulled) {
      pulled = false;
      return;
    }
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".sheet__grab, .sheet__head") || event.target.closest("button, a, input, select")) return;
    pull = { id: event.pointerId, y: event.clientY, t: event.timeStamp, moving: false };
  });
  dialog.addEventListener("pointermove", (event) => {
    if (!pull || event.pointerId !== pull.id) return;
    const dy = event.clientY - pull.y;
    // On ne prend la main qu'au-delà de quelques pixels : un simple appui reste un appui.
    if (!pull.moving && Math.abs(dy) < 6) return;
    if (!pull.moving) {
      pull.moving = true;
      dialog.setPointerCapture(event.pointerId);
      dialog.dataset.pulling = "";
    }
    dialog.style.transform = `translateY(${(dy >= 0 ? dy : rubberBand(dy, 400)).toFixed(1)}px)`;
  });
  const end = (event, cancelled) => {
    if (!pull || event.pointerId !== pull.id) return;
    const { moving, y, t } = pull;
    pull = null;
    if (!moving) return;
    pulled = true;
    setTimeout(() => (pulled = false), 0); // pas de « click » après ce geste : on oublie
    const dy = event.clientY - y;
    const speed = dy / Math.max(1, event.timeStamp - t);
    delete dialog.dataset.pulling;
    dialog.style.transform = "";
    if (!cancelled && (dy > 110 || (dy > 20 && speed > 0.3))) dialog.close();
  };
  dialog.addEventListener("pointerup", (event) => end(event, false));
  dialog.addEventListener("pointercancel", (event) => end(event, true));
}
