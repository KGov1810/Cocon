/**
 * Écran d'une pièce : onglets, grand chiffre réglable au doigt, niveau coloré
 * et vague, état de la pièce et quatre tuiles.
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
import { fillLevel, formatTemperature, isFlick, rubberBand, setpointFromDrag, splitTemperature, waveLevel } from "./logic.js";
import { icon } from "./ui.js";

const AXIS_THRESHOLD = 12;
const PX_PER_STEP = 22;
const ADJUSTABLE = new Set(["heat", "cool", "auto", "dry"]);
const ENTER_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

const $ = (id) => document.getElementById(id);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Le doigt peut régler la consigne de cette pièce maintenant. */
export function canAdjust(room) {
  return Boolean(room?.available && ADJUSTABLE.has(room.mode) && room.setpointRange && room.setpoint !== null);
}

/**
 * @param {{
 *   onSelect: (id: number, from: "left" | "right" | null) => void,
 *   onCommit: (id: number, value: number) => void,
 *   onDraft: (id: number, value: number) => void,
 *   onOpen: (id: number, kind: string) => void,
 * }} handlers
 */
export function createRoomView(handlers) {
  const scene = $("app");
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

  function renderTabs(modeLabel) {
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
      const on = r.available && r.mode !== "off" && r.mode !== "unknown";
      const sub = `${formatTemperature(r.temperature)} · ${r.available ? (on ? modeLabel[r.mode] : "Arrêt") : "Hors ligne"}`;
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

  /* ---------- Rendu ---------- */

  let ctx = null;

  /**
   * @param {object} next
   * @param {object[]} next.rooms           pièces affichées (valeurs en attente comprises)
   * @param {object} next.room              pièce active
   * @param {"left"|"right"|null} next.enter côté d'où arrive la pièce, après un changement
   * @param {object} next.labels            { mode, fan, options }
   * @param {string} next.idleHint          aide affichée quand on ne glisse pas
   */
  function update(next) {
    ctx = next;
    rooms = next.rooms;
    const previous = room?.id;
    room = next.room;
    idleHint = next.idleHint;
    render();
    if (previous !== undefined && previous !== room.id && next.enter && !drag) enter(next.enter);
  }

  function enter(from) {
    const offset = reducedMotion() ? 0 : from === "right" ? 56 : -56;
    content.animate(
      [
        { opacity: 0, transform: `translateX(${offset}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: reducedMotion() ? 160 : 280, easing: ENTER_EASE },
    );
  }

  function render() {
    if (!ctx || !room) return;
    const { labels } = ctx;
    const on = room.available && room.mode !== "off" && room.mode !== "unknown";
    const adjustable = canAdjust(room);

    scene.dataset.mode = room.available ? (ctx.absent ? "off" : room.mode) : "off";
    renderTabs(labels.mode);

    // Pendant un glissement, le doigt garde la main sur le chiffre et le niveau.
    if (!drag || drag.axis !== "y") {
      const fanOnly = room.mode === "fan";
      showNumber(fanOnly ? room.temperature : room.setpoint);
      showLevel(room.setpoint);
      hint.textContent = idleHint;
    }
    number.toggleAttribute("data-dim", !on || !adjustable);
    stateLabel.textContent = room.available ? (ctx.absent ? "Absence" : labels.mode[room.mode]) : "Hors ligne";
    measured.textContent =
      room.mode === "fan"
        ? "Température de la pièce, ventilation seule"
        : room.temperature !== null
          ? `Il fait ${formatTemperature(room.temperature)} dans la pièce`
          : "Température de la pièce indisponible";

    const strength = ctx.absent ? 0 : waveLevel(room);
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
    renderTile("mode", "Mode", labels.tile[room.mode] ?? "—", room.mode in labels.mode && room.mode !== "unknown" ? room.mode : "off", disabled);
    renderTile("fan", "Vitesse", room.fanSpeeds?.length ? (labels.fan[room.fan] ?? "—") : null, "speed", disabled);
    renderTile(
      "louver",
      "Volets",
      room.louvers?.length ? louver : null,
      room.louver === "swing" ? "swing" : `louver${room.louver ?? 1}`,
      disabled,
      louver.replace("Pos.", "position"),
    );
    renderTile("options", "Options", labels.options, room.powerful ? "boost" : "eco", disabled);
  }

  return { update };
}
