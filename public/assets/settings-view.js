/**
 * Panneaux de réglages d'une pièce, ouverts par les tuiles et le bandeau :
 * mode, vitesse, volets, options et programme.
 *
 * Comme absence-view.js, ce module ne fait qu'afficher : l'état et les envois
 * vivent dans app.js, qui reçoit les choix par des fonctions de rappel.
 */

import { el } from "./api.js";
import { FAN_LABEL, MODE_LABEL, MODE_SHORT, conflictWith } from "./logic.js";
import { programGroup } from "./program-editor.js";
import { chip, option, sheetHead } from "./ui.js";

const TITLE = { mode: "Mode", fan: "Vitesse", louver: "Volets", options: "Options", program: "Programme" };
const MODE_ORDER = ["heat", "cool", "auto", "dry", "fan", "off"];

/**
 * @param {object} room
 * @param {"mode"|"fan"|"louver"|"options"|"program"} kind
 * @param {object} ctx
 * @param {object[]} ctx.rooms         toutes les pièces (pour l'alerte multi-split)
 * @param {boolean} ctx.busy           commande en cours ou unité hors ligne
 * @param {HTMLElement} ctx.status     ligne d'état du panneau
 * @param {string|null} ctx.pendingMode mode en conflit qui attend une confirmation
 * @param {(setting: string, value: unknown, patch?: object) => void} ctx.send
 * @param {(mode: string) => boolean} ctx.chooseMode  true si le mode est parti
 * @param {() => void} ctx.onEdit      ouvre l'éditeur de programme
 * @param {() => void} ctx.onClose
 * @returns {{ head: HTMLElement, body: (HTMLElement|null)[] }}
 */
export function settingsView(room, kind, { rooms, busy, status, pendingMode, send, chooseMode, onEdit, onClose }) {
  // Un choix part et ferme le panneau ; toucher le choix actuel ferme seulement.
  const pick = (setting, value) => () => {
    if (room[setting] !== value) send(setting, value, { [setting]: value });
    onClose();
  };
  const toggle = (setting) => () => send(setting, !room[setting], { [setting]: !room[setting] });
  const grid = (chips) => el("div", { class: "chips chips--grid" }, chips);
  const help = (text) => el("p", { class: "group__help" }, text);

  let body = [];

  if (kind === "mode") {
    const conflict = pendingMode ? conflictWith(rooms, room.id, pendingMode) : null;
    body = [
      conflict
        ? el(
            "p",
            { class: "warning", role: "alert" },
            `${conflict.name} est en ${MODE_LABEL[conflict.mode].toLowerCase()}. Avec une seule unité extérieure, l'une des deux pièces restera en attente. Touchez à nouveau « ${MODE_SHORT[pendingMode]} » pour confirmer.`,
          )
        : null,
      grid(
        MODE_ORDER.filter((m) => room.modes.includes(m)).map((mode) =>
          chip(MODE_SHORT[mode], {
            iconName: mode,
            tone: mode,
            pressed: room.mode === mode,
            confirm: pendingMode === mode,
            disabled: busy,
            onclick: () => chooseMode(mode) && onClose(),
          }),
        ),
      ),
      help(`Ne change que la pièce « ${room.name} ».`),
    ];
  }

  if (kind === "fan" && room.fanSpeeds?.length) {
    body = [
      grid(
        room.fanSpeeds.map((speed) =>
          // Les icônes portent le nom de la vitesse (auto, low, medium, high, quiet).
          chip(FAN_LABEL[speed], { iconName: speed, pressed: room.fan === speed, disabled: busy, onclick: pick("fan", speed) }),
        ),
      ),
      help("Silence réduit le bruit de l'unité intérieure."),
    ];
  }

  if (kind === "louver" && room.louvers?.length) {
    const positions = room.louvers.filter((l) => l !== "swing");
    const choices = [...(room.louvers.includes("swing") ? ["swing"] : []), ...positions];
    body = [
      grid(
        choices.map((louver) =>
          chip(louver === "swing" ? "Balayage" : `Position ${louver}`, {
            iconName: louver === "swing" ? "swing" : `louver${louver}`,
            pressed: room.louver === louver,
            disabled: busy,
            onclick: pick("louver", louver),
          }),
        ),
      ),
      help(`Position 1 : souffle vers le haut. Position ${positions.length} : vers le bas.`),
    ];
  }

  if (kind === "options") {
    body = [
      room.powerful === undefined
        ? null
        : option("Pleine puissance", "Souffle au maximum pour atteindre la consigne plus vite.", room.powerful, busy, toggle("powerful")),
      room.economy === undefined
        ? null
        : option(
            "Économie d'énergie",
            "Limite la puissance de l'unité pour consommer moins. Coupez-la pour chauffer ou refroidir plus vite.",
            room.economy,
            busy,
            toggle("economy"),
          ),
    ];
  }

  if (kind === "program" && room.program) {
    body = [programGroup(room, { busy, onToggle: (follow) => send("program", follow), onEdit })];
  }

  return { head: sheetHead("sheet-title", `${TITLE[kind]} · ${room.name}`, onClose), body: [status, ...body] };
}
