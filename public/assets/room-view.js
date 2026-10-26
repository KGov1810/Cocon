/**
 * Écran d'une pièce : onglets, marche/arrêt, bandeau (programme ou absence),
 * grand chiffre réglable au doigt, niveau coloré et vague, lignes d'état,
 * quatre tuiles et couleur de la barre d'état.
 *
 * Ce module affiche et traduit les gestes ; l'état et les envois vivent dans
 * app.js, qui lui passe à chaque rendu ce qu'il faut montrer.
 *
 * Gestes sur la surface de réglage :
 * - vertical : un pas de consigne tous les 22 px, suivi 1:1, élastique aux
 *   bornes ; la consigne part au moment où le doigt se lève ;
 * - horizontal : le contenu suit le doigt ; un geste ample ou un coup sec
 *   change de pièce, sinon tout revient en place.
 * On attend 12 px avant de choisir l'axe, et un seul doigt compte à la fois.
 */

import { el } from "./api.js";
import {
  FAN_LABEL,
  MODE_LABEL,
  MODE_SHORT,
  canAdjust,
  conflictWith,
  describeRoom,
  fillLevel,
  formatTemperature,
  isFlick,
  isRunning,
  optionsSummary,
  rubberBand,
  setpointFromDrag,
  splitTemperature,
  waveLevel,
} from "./logic.js";
import { absenceText } from "./absence-view.js";
import { programLine } from "./program-editor.js";
import { icon } from "./ui.js";

const AXIS_THRESHOLD = 12;
const PX_PER_STEP = 22;
// Valeurs des tuiles : courtes, pour tenir sur une ligne.
const MODE_TILE = { ...MODE_SHORT, heat: "Chaud", unknown: "—" };

const $ = (id) => document.getElementById(id);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* La barre d'état prend la couleur du haut de l'écran ; à l'arrêt, celle du thème. */
const themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => ({ meta, base: meta.content }));
function setThemeColor(color) {
  for (const { meta, base } of themeMetas) meta.content = color ?? base;
}

/**
 * @param {{
 *   onSelect: (id: number, from: "left" | "right") => void,
 *   onCommit: (id: number, value: number) => void,
 *   onDraft: (id: number, value: number) => void,
 *   onOpen: (id: number, kind: string) => void,
 *   onPower: (id: number) => void,
 *   onAbsence: () => void,
 * }} handlers
 */
export function createRoomView(handlers) {
  const scene = $("app");
  const power = $("power");
  const ribbon = $("ribbon");
  const level = $("level");
  const wave = $("wave");
  const tabs = $("tabs");
  const dial = $("dial");
  const content = $("dial-content");
  const number = $("dial-number");
  const whole = $("dial-whole");
  const decimal = $("dial-decimal");
  const stateLabel = $("dial-state");
  const measured = $("dial-measured");
  const hint = $("dial-hint");
  const range = $("setpoint");
  const tiles = $("tiles");
  const sections = [dial, $("room-status"), tiles];

  let rooms = [];
  let room = null; // pièce affichée
  let idleHint = "";
  let drag = null;

  /* ---------- Affichage du chiffre et du niveau ---------- */

  function showNumber(value) {
    const parts = splitTemperature(value);
    whole.textContent = parts.whole;
    decimal.textContent = parts.decimal;
  }

  function showLevel(setpoint) {
    const fill = fillLevel({ ...room, setpoint });
    level.style.transform = `translateY(${((1 - fill) * 100).toFixed(2)}%)`;
  }

  /* ---------- Gestes ---------- */

  function neighbour(step) {
    const index = rooms.findIndex((r) => r.id === room.id);
    return rooms[(index + step + rooms.length) % rooms.length];
  }

  function resetDrag() {
    number.style.transform = "";
    content.style.transform = "";
    content.style.opacity = "";
    dial.removeAttribute("data-drag");
    drag = null;
  }

  dial.addEventListener("pointerdown", (event) => {
    if (drag || !room) return; // un seul doigt à la fois
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dial.setPointerCapture(event.pointerId);
    drag = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      t: event.timeStamp,
      axis: null,
      dx: 0,
      roomId: room.id,
      start: room.setpoint,
      value: room.setpoint,
    };
  });

  dial.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = event.clientX - drag.x;
    const dy = drag.y - event.clientY;
    if (!drag.axis && Math.max(Math.abs(dx), Math.abs(dy)) > AXIS_THRESHOLD) {
      if (Math.abs(dy) >= Math.abs(dx) && canAdjust(room)) drag.axis = "y";
      else if (Math.abs(dx) > Math.abs(dy) && rooms.length > 1) drag.axis = "x";
      else drag.axis = "none";
      dial.dataset.drag = drag.axis;
    }

    if (drag.axis === "y") {
      const result = setpointFromDrag(room, drag.start, dy, PX_PER_STEP);
      drag.value = result.value;
      showNumber(result.value);
      showLevel(result.value);
      number.style.transform = `translateY(${(-rubberBand(result.overshoot, 120)).toFixed(1)}px) scale(1.04)`;
      const delta = result.value - drag.start;
      if (result.overshoot > 0) hint.textContent = `Maximum ${formatTemperature(room.setpointRange.max)}`;
      else if (result.overshoot < 0) hint.textContent = `Minimum ${formatTemperature(room.setpointRange.min)}`;
      else if (delta === 0) hint.textContent = "Relâchez pour garder la consigne";
      else hint.textContent = `${delta > 0 ? "+" : "−"}${formatTemperature(Math.abs(delta))} · relâchez pour envoyer`;
    } else if (drag.axis === "x") {
      drag.dx = dx;
      content.style.transform = `translateX(${dx}px)`;
      content.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 320));
    }
  });

  function finish(event, cancelled) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { axis, dx, t, roomId, start, value } = drag;
    resetDrag();
    if (cancelled) return render();
    if (axis === "y" && value !== start) return handlers.onCommit(roomId, value);
    if (axis === "x" && isFlick(dx, event.timeStamp - t)) {
      const next = neighbour(dx < 0 ? 1 : -1);
      return handlers.onSelect(next.id, dx < 0 ? "right" : "left");
    }
    render();
  }

  dial.addEventListener("pointerup", (event) => finish(event, false));
  dial.addEventListener("pointercancel", (event) => finish(event, true));

  // Curseur natif (VoiceOver, clavier) : même réglage, envoyé après une courte pause.
  range.addEventListener("input", () => {
    if (!room) return;
    const value = Number(range.value);
    showNumber(value);
    showLevel(value);
    handlers.onDraft(room.id, value);
  });

  /* ---------- Onglets et tuiles ---------- */

  function renderTabs() {
    const signature = rooms.map((r) => `${r.id}:${r.name}`).join("|");
    if (tabs.dataset.signature !== signature) {
      tabs.dataset.signature = signature;
      tabs.replaceChildren(
        ...rooms.map((r) =>
          el("button", { class: "tab", type: "button", "data-id": String(r.id), onclick: () => select(r.id) }, [
            el("span", { class: "tab__name" }),
            el("span", { class: "tab__sub" }),
          ]),
        ),
      );
    }
    tabs.hidden = rooms.length < 2;
    for (const button of tabs.children) {
      const r = rooms.find((x) => String(x.id) === button.dataset.id);
      const sub = `${formatTemperature(r.temperature)} · ${r.available ? (isRunning(r) ? MODE_SHORT[r.mode] : "Arrêt") : "Hors ligne"}`;
      button.firstChild.textContent = r.name;
      button.lastChild.textContent = sub;
      button.setAttribute("aria-pressed", r.id === room.id ? "true" : "false");
      button.setAttribute("aria-label", `${r.name}, ${sub.replace(" · ", ", ")}`);
    }
  }

  function select(id) {
    if (id === room?.id) return;
    const from = rooms.findIndex((r) => r.id === id) > rooms.findIndex((r) => r.id === room?.id) ? "right" : "left";
    handlers.onSelect(id, from);
  }

  const TILE_KINDS = ["mode", "fan", "louver", "options"];
  const tileNodes = new Map();
  for (const kind of TILE_KINDS) {
    const node = el("button", { class: "tile", type: "button", "aria-haspopup": "dialog", onclick: () => room && handlers.onOpen(room.id, kind) }, [
      el("span", { class: "tile__icon" }),
      el("span", { class: "tile__text" }, [el("span", { class: "tile__label" }), el("span", { class: "tile__value" })]),
    ]);
    tileNodes.set(kind, node);
    tiles.append(node);
  }

  function renderTile(kind, label, value, iconName, disabled, spoken = value) {
    const node = tileNodes.get(kind);
    node.hidden = value === null;
    if (value === null) return;
    node.disabled = disabled;
    node.querySelector(".tile__label").textContent = label;
    node.querySelector(".tile__value").textContent = value;
    node.setAttribute("aria-label", `${label} : ${spoken}. Modifier`);
    if (node.dataset.icon !== iconName) {
      node.dataset.icon = iconName;
      node.querySelector(".tile__icon").replaceChildren(icon(iconName));
    }
  }

  power.append(icon("power"));
  power.addEventListener("click", () => room && handlers.onPower(room.id));
  ribbon.addEventListener("click", () => {
    if (ribbon.dataset.kind === "absence") return handlers.onAbsence();
    if (room) handlers.onOpen(room.id, "program");
  });

  /* ---------- Rendu ---------- */

  let ctx = null;

  /**
   * @param {object} next
   * @param {object[]} next.rooms         pièces affichées (valeurs en attente comprises)
   * @param {object} next.room            pièce active
   * @param {object|null} next.absence    absence renvoyée par le relais
   * @param {boolean} next.busy           une commande est en cours pour la pièce
   * @param {object|null} next.status     retour de commande à montrer (voir shownStatus)
   * @param {string|null} next.updatedAt  date de la dernière lecture
   * @param {string|null} next.onMode     mode de rallumage d'une pièce arrêtée
   */
  function update(next) {
    ctx = next;
    rooms = next.rooms;
    room = next.room;
    if (canAdjust(room)) idleHint = rooms.length > 1 ? "Glissez ↕ pour régler · ↔ pour changer de pièce" : "Glissez vers le haut ou le bas pour régler";
    else idleHint = rooms.length > 1 ? "Glissez ↔ pour changer de pièce" : "";
    for (const node of sections) node.hidden = false;
    render();
  }

  /** Aucune pièce à montrer (chargement, compte vide, déconnexion). */
  function clear() {
    ctx = null;
    room = null;
    scene.dataset.mode = "off";
    for (const node of [ribbon, power, ...sections]) node.hidden = true;
    setThemeColor(null);
  }

  /** La nouvelle pièce glisse depuis le côté d'où elle vient. */
  function slideIn(from) {
    const offset = reducedMotion() ? 0 : from === "right" ? 56 : -56;
    content.animate(
      [
        { opacity: 0, transform: `translateX(${offset}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      // Même courbe que le reste de l'interface (--ease-out, dans styles.css).
      { duration: reducedMotion() ? 160 : 280, easing: getComputedStyle(scene).getPropertyValue("--ease-out").trim() },
    );
  }

  function render() {
    if (!ctx || !room) return;
    const absent = ctx.absence?.status === "on";
    const on = isRunning(room);
    const adjustable = canAdjust(room);

    scene.dataset.mode = room.available && !absent ? room.mode : "off";
    renderTabs();
    renderBar(on);

    // Pendant un glissement, le doigt garde la main sur le chiffre et le niveau.
    if (!drag || drag.axis !== "y") {
      const fanOnly = room.mode === "fan";
      showNumber(fanOnly ? room.temperature : room.setpoint);
      showLevel(room.setpoint);
      hint.textContent = idleHint;
    }
    number.toggleAttribute("data-dim", !on || !adjustable);
    stateLabel.textContent = room.available ? (absent ? "Absence" : MODE_SHORT[room.mode]) : "Hors ligne";
    measured.textContent =
      room.mode === "fan"
        ? "Température de la pièce, ventilation seule"
        : room.temperature !== null
          ? `Il fait ${formatTemperature(room.temperature)} dans la pièce`
          : "Température de la pièce indisponible";

    const strength = absent ? 0 : waveLevel(room);
    wave.style.animationDuration = `${(6 - 4.5 * strength).toFixed(2)}s`;
    wave.toggleAttribute("data-still", strength === 0);

    dial.classList.toggle("dial--locked", !adjustable);
    range.disabled = !adjustable;
    if (room.setpointRange) {
      range.min = String(room.setpointRange.min);
      range.max = String(room.setpointRange.max);
      range.step = String(room.setpointRange.step);
    }
    if (room.setpoint !== null && document.activeElement !== range) range.value = String(room.setpoint);
    range.setAttribute("aria-valuetext", `${formatTemperature(room.setpoint).replace("°", " degrés")}`);
    range.labels[0].textContent = `Consigne, ${room.name}`;

    const louver = room.louver === "swing" ? "Balayage" : room.louver ? `Pos. ${room.louver}` : "—";
    const disabled = !room.available;
    renderTile("mode", "Mode", MODE_TILE[room.mode] ?? "—", room.mode in MODE_LABEL && room.mode !== "unknown" ? room.mode : "off", disabled);
    renderTile("fan", "Vitesse", room.fanSpeeds?.length ? (FAN_LABEL[room.fan] ?? "—") : null, "speed", disabled);
    renderTile(
      "louver",
      "Volets",
      room.louvers?.length ? louver : null,
      room.louver === "swing" ? "swing" : `louver${room.louver ?? 1}`,
      disabled,
      louver.replace("Pos.", "position"),
    );
    renderTile("options", "Options", optionsSummary(room), room.powerful ? "boost" : "eco", disabled);

    renderStatus(on, absent);
    // Barre d'état de l'iPhone : la couleur du mode, lue dans la feuille de style (app.css).
    setThemeColor(on && !absent ? getComputedStyle(scene).getPropertyValue("--scene-bg").trim() : null);
  }

  /** Marche/arrêt et bandeau : absence en cours, sinon programme de la pièce. */
  function renderBar(on) {
    power.hidden = !room.available;
    power.disabled = ctx.busy;
    power.setAttribute("aria-pressed", on ? "true" : "false");
    power.setAttribute("aria-label", on ? `Éteindre : ${room.name}` : `Allumer : ${room.name}`);

    const absence = absenceText(ctx.absence);
    let text = null;
    let iconName = "calendar";
    if (absence) {
      text = absence;
      iconName = "bag";
    } else if (room.program && room.available) {
      text = programLine(room) ?? "Programme désactivé · le régler";
      iconName = room.program.override?.active ? "clock" : "calendar";
    }
    ribbon.hidden = !text;
    $("ribbon-text").textContent = text ?? "";
    ribbon.dataset.kind = absence ? "absence" : "program";
    if (ribbon.dataset.icon !== iconName) {
      ribbon.dataset.icon = iconName;
      $("ribbon-icon").replaceChildren(icon(iconName));
    }
  }

  /** Ligne d'état, conflit multi-split, retour de commande (ou heure de mise à jour). */
  function renderStatus(on, absent) {
    $("status-line").textContent = describeRoom(room, { absent, onMode: ctx.onMode });
    const conflict = on && !absent ? conflictWith(rooms, room.id, room.mode) : null;
    $("conflict-line").hidden = !conflict;
    $("conflict-line").textContent = conflict
      ? `${conflict.name} est en ${MODE_LABEL[conflict.mode].toLowerCase()} : une seule unité extérieure ne peut pas chauffer et refroidir en même temps.`
      : "";

    const { status, updatedAt } = ctx;
    const updated = updatedAt
      ? `À jour à ${new Date(updatedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · vague estimée d'après vos réglages`
      : "";
    const sendLine = $("send-line");
    sendLine.dataset.kind = status?.kind ?? "";
    sendLine.replaceChildren(el("span", { class: "room__dot", "aria-hidden": "true" }), status?.text ?? updated);
  }

  return { update, clear, slideIn };
}
