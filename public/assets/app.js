/**
 * Tableau de bord Cocon : une pièce à la fois, réglée au doigt, et des panneaux
 * de réglages (mode, vitesse, volets, options, programme) ouverts par les tuiles.
 *
 * - L'état vient de GET /api/state, relu toutes les 20 s quand l'appli est
 *   visible (et aussitôt quand on y revient).
 * - Chaque commande part vers POST /api/rooms/<id>. La valeur demandée s'affiche
 *   tout de suite ; elle reste affichée jusqu'à ce qu'Atlantic la renvoie (90 s max).
 * - Une seule commande à la fois par pièce. La consigne part quand le doigt se
 *   lève ; au clavier ou avec VoiceOver, 1,2 s après le dernier réglage.
 */

import { api, el } from "./api.js";
import { applyOptimistic, conflictWith, describeOutcome, optionsSummary, powerOnMode, rubberBand } from "./logic.js";
import { createSignin, signOut } from "./session.js";
import { chip, icon, option } from "./ui.js";
import { editorView, openEditor, programGroup, programLine, reloadEditor } from "./program-editor.js";
import { absenceText, absenceView, newAbsenceForm } from "./absence-view.js";
import { canAdjust, createRoomView } from "./room-view.js";

const POLL_MS = 20_000;
const OPTIMISTIC_MS = 90_000;
const SETPOINT_DEBOUNCE_MS = 1200;
const STATUS_VISIBLE_MS = 45_000;

const MODE_LABEL = {
  off: "Arrêt",
  heat: "Chauffage",
  cool: "Froid",
  auto: "Auto",
  fan: "Ventilation",
  dry: "Déshumidification",
  unknown: "État inconnu",
};
const MODE_SHORT = { ...MODE_LABEL, dry: "Déshum.", fan: "Ventil." };
// Valeurs des tuiles : courtes, pour tenir sur une ligne.
const MODE_TILE = { ...MODE_SHORT, heat: "Chaud", unknown: "—" };
const MODE_ORDER = ["heat", "cool", "auto", "dry", "fan", "off"];
const FAN_LABEL = { auto: "Auto", low: "Basse", medium: "Moyenne", high: "Haute", quiet: "Silence" };
const FAN_ICON = { auto: "auto", low: "low", medium: "medium", high: "high", quiet: "quiet" };
const SHEET_TITLE = { mode: "Mode", fan: "Vitesse", louver: "Volets", options: "Options", program: "Programme" };
// Couleur de la barre d'état de l'iPhone : celle du haut de l'écran.
const SCENE_COLOR = { heat: "#c93c17", cool: "#1d62b0", auto: "#5e43c2", fan: "#0d6e63", dry: "#0d6e63" };

const $ = (id) => document.getElementById(id);

/* ---------- État ---------- */

const state = {
  raw: [], // pièces telles que renvoyées par le relais
  view: [], // pièces affichées (avec les valeurs en attente de confirmation)
  updatedAt: null,
  error: null,
  loading: false,
  optimistic: new Map(), // id → { champ: { value, until } }
  busy: new Set(), // pièces dont une commande est en cours
  status: new Map(), // id → { kind, text, at }
  drafts: new Map(), // id → minuterie de la consigne en cours de réglage (clavier, VoiceOver)
  confirmMode: null, // { id, mode } : mode en conflit qui attend une confirmation
  active: null, // pièce affichée
  enter: null, // côté d'où arrive la pièce après un changement
  sheetRoom: null, // pièce dont un panneau est ouvert
  sheetKind: null, // "mode" | "fan" | "louver" | "options" | "program"
  editor: null, // éditeur de programme ouvert dans le panneau (voir program-editor.js)
  absence: null, // état de l'absence renvoyé par le relais
  absenceForm: null, // formulaire de la fiche Absence
  absenceBusy: false,
  absenceStatus: null, // { kind, text, at }
};

const roomById = (id) => state.view.find((r) => r.id === id);

/* Confort propre à ce téléphone : dernier mode par pièce, dernière pièce affichée. */
function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible : on retombera sur les valeurs par défaut */
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function rememberMode(id, mode) {
  if (!mode || mode === "off" || mode === "unknown") return;
  remember(`cocon.lastMode.${id}`, mode);
}

const rememberedMode = (id) => recall(`cocon.lastMode.${id}`);

function setOptimistic(id, patch) {
  const until = Date.now() + OPTIMISTIC_MS;
  const current = { ...(state.optimistic.get(id) ?? {}) };
  for (const [field, value] of Object.entries(patch)) current[field] = { value, until };
  state.optimistic.set(id, current);
}

function dropOptimistic(id, patch) {
  const current = { ...(state.optimistic.get(id) ?? {}) };
  for (const field of Object.keys(patch ?? {})) delete current[field];
  if (Object.keys(current).length) state.optimistic.set(id, current);
  else state.optimistic.delete(id);
}

function setStatus(id, kind, text) {
  state.status.set(id, { kind, text, at: Date.now() });
}

/* ---------- Échanges avec le relais ---------- */

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $("refresh").setAttribute("aria-busy", "true");
  try {
    const data = await api("GET", "/api/state");
    state.raw = data.rooms;
    state.absence = data.absence;
    state.updatedAt = data.updatedAt;
    state.error = null;
    for (const room of data.rooms) rememberMode(room.id, room.mode);
  } catch (err) {
    if (err.status === 401) return showSignin(err.message);
    state.error =
      err.code === "RATE_LIMITED"
        ? `${err.message} L'appli Cozytouch partage ce quota.`
        : `${err.message} Nouvel essai automatique dans 20 s.`;
  } finally {
    state.loading = false;
    $("refresh").removeAttribute("aria-busy");
    render();
  }
}

/** Envoie une commande ; renvoie true si Atlantic l'a acceptée (confirmée ou en attente). */
async function send(room, setting, value, patch) {
  if (state.busy.has(room.id)) return false;
  state.busy.add(room.id);
  state.confirmMode = null;
  if (patch) setOptimistic(room.id, patch);
  if (setting === "mode") rememberMode(room.id, value);
  setStatus(room.id, "sending", "Envoi à Atlantic…");
  render();
  try {
    const result = await api("POST", `/api/rooms/${room.id}`, { setting, value });
    setStatus(room.id, result.status === "confirmed" ? "ok" : "pending", describeOutcome(result));
    setTimeout(refresh, result.status === "confirmed" ? 1500 : 8000);
    return true;
  } catch (err) {
    if (err.status === 401) {
      showSignin(err.message);
      return false;
    }
    dropOptimistic(room.id, patch);
    setStatus(room.id, "error", err.message);
    refresh();
    return false;
  } finally {
    state.busy.delete(room.id);
    render();
  }
}

/** Doigt levé : la consigne part tout de suite. */
function commitSetpoint(id, value) {
  const room = roomById(id);
  if (!room) return;
  clearTimeout(state.drafts.get(id));
  state.drafts.delete(id);
  if (state.busy.has(id)) {
    setStatus(id, "error", "Une commande est déjà en cours pour cette pièce : réessayez dans un instant.");
    return render();
  }
  if (value !== room.setpoint) send(room, "setpoint", value, { setpoint: value });
  else render();
}

/** Curseur natif (clavier, VoiceOver) : la consigne part après le dernier réglage. */
function draftSetpoint(id, value) {
  const room = roomById(id);
  if (!room || state.busy.has(id)) return;
  setOptimistic(id, { setpoint: value });
  setStatus(id, "draft", "Envoi dans un instant…");
  clearTimeout(state.drafts.get(id));
  state.drafts.set(
    id,
    setTimeout(() => {
      state.drafts.delete(id);
      const current = roomById(id);
      if (current) send(current, "setpoint", value, { setpoint: value });
    }, SETPOINT_DEBOUNCE_MS),
  );
  render();
}

/** Renvoie true si la commande est partie (et non en attente de confirmation). */
function chooseMode(id, mode) {
  const room = roomById(id);
  if (!room || room.mode === mode) return true;
  const conflict = conflictWith(state.view, id, mode);
  const confirmed = state.confirmMode?.id === id && state.confirmMode.mode === mode;
  if (conflict && !confirmed) {
    state.confirmMode = { id, mode };
    setStatus(
      id,
      "confirm",
      `${conflict.name} est en ${MODE_LABEL[conflict.mode].toLowerCase()} : touchez à nouveau pour passer quand même en ${MODE_LABEL[mode].toLowerCase()}.`,
    );
    render();
    return false;
  }
  send(room, "mode", mode, { mode });
  return true;
}

function togglePower(id) {
  const room = roomById(id);
  if (!room) return;
  if (room.mode !== "off") return send(room, "mode", "off", { mode: "off" });
  const mode = powerOnMode(room, rememberedMode(id), new Date().getMonth());
  if (!mode) return;
  // En conflit, la confirmation se fait dans le panneau Mode.
  if (conflictWith(state.view, id, mode)) openSheet(id, "mode");
  chooseMode(id, mode);
}

function selectRoom(id, from) {
  if (id === state.active) return;
  state.active = id;
  state.enter = from;
  remember("cocon.room", String(id));
  render();
  state.enter = null;
}

/* ---------- Écran de la pièce ---------- */

const roomView = createRoomView({
  onSelect: selectRoom,
  onCommit: commitSetpoint,
  onDraft: draftSetpoint,
  onOpen: openSheet,
});

/** Texte de la ligne d'état de la pièce. */
function describeRoom(room) {
  const t = room.temperature;
  if (!room.available) return "Unité injoignable : vérifiez le hub Cozytouch.";
  if (absentNow()) return "Arrêtée pendant l'absence";
  switch (room.mode) {
    case "heat":
      return t !== null && t >= room.setpoint ? "Consigne atteinte, l'unité ralentit" : "Chauffe pour atteindre la consigne";
    case "cool":
      return t !== null && t <= room.setpoint ? "Consigne atteinte, l'unité ralentit" : "Refroidit pour atteindre la consigne";
    case "auto":
      return "Chauffe ou refroidit selon la pièce";
    case "dry":
      return "Déshumidifie la pièce";
    case "fan":
      return "Ventilation seule, sans consigne";
    case "unknown":
      return "État inconnu : actualisez dans un instant";
    default: {
      const onMode = powerOnMode(room, rememberedMode(room.id), new Date().getMonth());
      return onMode ? `À l'arrêt · se rallumera en ${MODE_LABEL[onMode].toLowerCase()}` : "À l'arrêt";
    }
  }
}

const absentNow = () => state.absence?.status === "on";

function renderRoom() {
  const has = state.view.length > 0;
  $("loading").hidden = state.updatedAt !== null || Boolean(state.error);
  $("empty").hidden = state.updatedAt === null || has;
  for (const id of ["dial", "room-status", "tiles"]) $(id).hidden = !has;
  if (!has) {
    $("app").dataset.mode = "off";
    $("ribbon").hidden = true;
    $("power").hidden = true;
    return updateThemeColor(null);
  }

  if (!roomById(state.active)) {
    const stored = Number(recall("cocon.room"));
    state.active = roomById(stored) ? stored : state.view[0].id;
  }
  const room = roomById(state.active);
  const id = room.id;
  const on = room.available && room.mode !== "off" && room.mode !== "unknown";

  let idleHint = "";
  if (canAdjust(room)) idleHint = state.view.length > 1 ? "Glissez ↕ pour régler · ↔ pour changer de pièce" : "Glissez vers le haut ou le bas pour régler";
  else if (state.view.length > 1) idleHint = "Glissez ↔ pour changer de pièce";

  roomView.update({
    rooms: state.view,
    room,
    enter: state.enter,
    absent: absentNow(),
    idleHint,
    labels: { mode: MODE_SHORT, tile: MODE_TILE, fan: FAN_LABEL, options: optionsSummary(room) },
  });

  // Marche / arrêt de la pièce affichée.
  const power = $("power");
  power.hidden = !room.available;
  power.disabled = state.busy.has(id);
  power.setAttribute("aria-pressed", on ? "true" : "false");
  power.setAttribute("aria-label", on ? `Éteindre : ${room.name}` : `Allumer : ${room.name}`);

  // Bandeau : absence en cours, sinon programme de la pièce.
  const ribbon = $("ribbon");
  const absence = absenceText(state.absence);
  let ribbonText = null;
  let ribbonIcon = "calendar";
  if (absence) {
    ribbonText = absence;
    ribbonIcon = "bag";
  } else if (room.program && room.available) {
    ribbonText = programLine(room) ?? "Programme désactivé · le régler";
    ribbonIcon = room.program.override?.active ? "clock" : "calendar";
  }
  ribbon.hidden = !ribbonText;
  $("ribbon-text").textContent = ribbonText ?? "";
  ribbon.dataset.kind = absence ? "absence" : "program";
  if (ribbon.dataset.icon !== ribbonIcon) {
    ribbon.dataset.icon = ribbonIcon;
    $("ribbon-icon").replaceChildren(icon(ribbonIcon));
  }

  // Ligne d'état, conflit multi-split, retour de commande.
  $("status-line").textContent = describeRoom(room);
  const conflict = on && !absentNow() ? conflictWith(state.view, id, room.mode) : null;
  $("conflict-line").hidden = !conflict;
  $("conflict-line").textContent = conflict
    ? `${conflict.name} est en ${MODE_LABEL[conflict.mode].toLowerCase()} : une seule unité extérieure ne peut pas chauffer et refroidir en même temps.`
    : "";

  const current = state.status.get(id);
  const visible = current && (current.kind === "sending" || current.kind === "draft" || Date.now() - current.at < STATUS_VISIBLE_MS);
  const updated = state.updatedAt
    ? `À jour à ${new Date(state.updatedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · vague estimée d'après vos réglages`
    : "";
  const sendLine = $("send-line");
  sendLine.dataset.kind = visible ? current.kind : "";
  sendLine.replaceChildren(
    el("span", { class: "room__dot", "aria-hidden": "true" }),
    visible ? current.text : updated,
  );

  updateThemeColor(on && !absentNow() ? SCENE_COLOR[room.mode] : null);
}

/* La barre d'état prend la couleur du haut de l'écran ; à l'arrêt, celle du thème. */
const themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => ({ meta, base: meta.content }));
function updateThemeColor(color) {
  for (const { meta, base } of themeMetas) meta.content = color ?? base;
}

/* ---------- Panneaux de réglages ---------- */

const sheet = $("sheet");

let sheetSignature = null;

function sheetHead(title, onClose) {
  return el("div", { class: "sheet__head" }, [
    el("h2", { id: "sheet-title" }, title),
    el("span", { class: "spacer" }),
    el("button", { class: "button button--quiet", type: "button", onclick: onClose }, "Fermer"),
  ]);
}

const grab = () => el("div", { class: "sheet__grab", "aria-hidden": "true" });

/** Choix qui ferme le panneau une fois envoyé. */
function sendAndClose(room, setting, value, patch) {
  send(room, setting, value, patch);
  sheet.close();
}

function renderSheet() {
  const room = roomById(state.sheetRoom);
  if (!room) return sheet.open && sheet.close();
  const id = room.id;
  const kind = state.sheetKind;
  const busy = state.busy.has(id) || !room.available;
  const current = state.status.get(id);

  // On ne reconstruit le panneau que si son contenu change (le rafraîchissement
  // toutes les 20 s ne doit pas voler un appui en cours).
  const signature = JSON.stringify([kind, room, busy, current, state.confirmMode, state.editor, state.view.map((r) => r.mode)]);
  if (signature === sheetSignature && sheet.childElementCount) return;
  sheetSignature = signature;

  // L'encadré d'alerte remplace le message de confirmation dans le panneau.
  const visible =
    current &&
    current.kind !== "confirm" &&
    (current.kind === "sending" || current.kind === "draft" || Date.now() - current.at < STATUS_VISIBLE_MS);
  const status = el("p", { class: "sheet__status", "aria-live": "polite", "data-kind": visible ? current.kind : "", hidden: !visible && room.available }, [
    visible && (current.kind === "sending" || current.kind === "draft")
      ? el("span", { class: "spinner", "aria-hidden": "true" })
      : null,
    visible ? current.text : room.available ? null : "Unité hors ligne : réglages indisponibles.",
  ]);

  if (kind === "program" && state.editor?.roomId === id && room.program) {
    const view = editorView(room, state.editor, {
      busy,
      status,
      onChange: (patch, reload) => {
        state.editor = reload ? reloadEditor(room, state.editor, patch) : { ...state.editor, ...patch };
        renderSheet();
      },
      onSave: async (value) => {
        if (await send(room, "schedule", value)) state.editor = { ...state.editor, dirty: false };
        render();
      },
      onCancel: () => {
        state.editor = reloadEditor(room, state.editor);
        renderSheet();
      },
      onBack: () => {
        state.editor = null;
        renderSheet();
      },
    });
    sheet.replaceChildren(grab(), view.head, el("div", { class: "sheet__body" }, view.body));
    return;
  }

  const body = [status];

  if (kind === "mode") {
    const pending = state.confirmMode?.id === id ? state.confirmMode.mode : null;
    const conflict = pending ? conflictWith(state.view, id, pending) : null;
    if (conflict) {
      body.push(
        el(
          "p",
          { class: "warning", role: "alert" },
          `${conflict.name} est en ${MODE_LABEL[conflict.mode].toLowerCase()}. Avec une seule unité extérieure, l'une des deux pièces restera en attente. Touchez à nouveau « ${MODE_SHORT[pending]} » pour confirmer.`,
        ),
      );
    }
    body.push(
      el(
        "div",
        { class: "chips chips--grid" },
        MODE_ORDER.filter((m) => room.modes.includes(m)).map((mode) =>
          chip(MODE_SHORT[mode], {
            iconName: mode,
            tone: mode,
            pressed: room.mode === mode,
            confirm: pending === mode,
            disabled: busy,
            onclick: () => {
              if (room.mode === mode) return sheet.close();
              if (chooseMode(id, mode)) sheet.close();
            },
          }),
        ),
      ),
      el("p", { class: "group__help" }, `Ne change que la pièce « ${room.name} ».`),
    );
  }

  if (kind === "fan" && room.fanSpeeds?.length) {
    body.push(
      el(
        "div",
        { class: "chips chips--grid" },
        room.fanSpeeds.map((speed) =>
          chip(FAN_LABEL[speed], {
            iconName: FAN_ICON[speed] ?? "speed",
            pressed: room.fan === speed,
            disabled: busy,
            onclick: () => (room.fan === speed ? sheet.close() : sendAndClose(room, "fan", speed, { fan: speed })),
          }),
        ),
      ),
      el("p", { class: "group__help" }, "Silence réduit le bruit de l'unité intérieure."),
    );
  }

  if (kind === "louver" && room.louvers?.length) {
    const positions = room.louvers.filter((l) => l !== "swing");
    const choices = [...(room.louvers.includes("swing") ? ["swing"] : []), ...positions];
    body.push(
      el(
        "div",
        { class: "chips chips--grid" },
        choices.map((louver) =>
          chip(louver === "swing" ? "Balayage" : `Position ${louver}`, {
            iconName: louver === "swing" ? "swing" : `louver${louver}`,
            pressed: room.louver === louver,
            disabled: busy,
            onclick: () => (room.louver === louver ? sheet.close() : sendAndClose(room, "louver", louver, { louver })),
          }),
        ),
      ),
      el("p", { class: "group__help" }, `Position 1 : souffle vers le haut. Position ${positions.length} : vers le bas.`),
    );
  }

  if (kind === "options") {
    if (room.powerful !== undefined) {
      body.push(
        option("Pleine puissance", "Souffle au maximum pour atteindre la consigne plus vite.", room.powerful, busy, () =>
          send(room, "powerful", !room.powerful, { powerful: !room.powerful }),
        ),
      );
    }
    if (room.economy !== undefined) {
      body.push(
        option(
          "Économie d'énergie",
          "Limite la puissance de l'unité pour consommer moins. Coupez-la pour chauffer ou refroidir plus vite.",
          room.economy,
          busy,
          () => send(room, "economy", !room.economy, { economy: !room.economy }),
        ),
      );
    }
  }

  if (kind === "program" && room.program) {
    body.push(
      programGroup(room, {
        busy,
        onToggle: (follow) => send(room, "program", follow),
        onEdit: () => {
          state.editor = openEditor(room);
          renderSheet();
        },
      }),
    );
  }

  sheet.replaceChildren(
    grab(),
    sheetHead(`${SHEET_TITLE[kind]} · ${room.name}`, () => sheet.close()),
    el("div", { class: "sheet__body" }, body),
  );
}

function openSheet(id, kind) {
  state.sheetRoom = id;
  state.sheetKind = kind;
  state.confirmMode = null;
  state.editor = null;
  sheetSignature = null;
  renderSheet();
  if (!sheet.open) sheet.showModal();
}

sheet.addEventListener("close", () => {
  state.sheetRoom = null;
  state.sheetKind = null;
  state.confirmMode = null;
  state.editor = null;
  render();
});

/**
 * Fermeture des panneaux : toucher le fond assombri, ou tirer la poignée (ou
 * l'en-tête) vers le bas. Un geste ample ou un coup sec suffit.
 */
function enableDismiss(dialog) {
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

/* ---------- Absence ---------- */

const absenceDialog = $("absence");

function renderAbsence() {
  const s = state.absenceStatus;
  const status = el("p", { class: "sheet__status", "aria-live": "polite", "data-kind": s?.kind ?? "" }, [
    s?.kind === "sending" ? el("span", { class: "spinner", "aria-hidden": "true" }) : null,
    s?.text ?? "",
  ]);
  const view = absenceView(state.absence, state.absenceForm, {
    busy: state.absenceBusy,
    status,
    onChange: (patch) => {
      state.absenceForm = { ...state.absenceForm, ...patch };
      renderAbsence();
    },
    onSubmit: (window) => sendAbsence(window),
    onCancelAbsence: () => sendAbsence(null),
    onClose: () => absenceDialog.close(),
  });
  absenceDialog.replaceChildren(grab(), view.head, el("div", { class: "sheet__body" }, view.body));
}

function openAbsence() {
  if ($("more").open) $("more").close();
  state.absenceForm = newAbsenceForm();
  state.absenceStatus = null;
  renderAbsence();
  absenceDialog.showModal();
}

/** Programme (fenêtre en secondes) ou annule (null) l'absence. */
async function sendAbsence(window) {
  state.absenceBusy = true;
  state.absenceStatus = { kind: "sending", text: "Envoi à Atlantic…" };
  renderAbsence();
  try {
    const result = window ? await api("POST", "/api/absence", window) : await api("DELETE", "/api/absence");
    state.absenceStatus = { kind: result.status === "confirmed" ? "ok" : "pending", text: describeOutcome(result) };
    setTimeout(refresh, 1500);
  } catch (err) {
    if (err.status === 401) return showSignin(err.message);
    state.absenceStatus = { kind: "error", text: err.message };
  } finally {
    state.absenceBusy = false;
    if (absenceDialog.open) renderAbsence();
  }
}

/* ---------- Rendu ---------- */

function render() {
  const merged = applyOptimistic(state.raw, state.optimistic, Date.now());
  state.optimistic = merged.optimistic;
  state.view = merged.rooms;

  // Éditeur sans modification en cours : il suit l'état reçu d'Atlantic.
  if (state.editor && !state.editor.dirty) {
    const room = roomById(state.editor.roomId);
    state.editor = room?.program ? reloadEditor(room, state.editor) : null;
  }

  renderRoom();

  // La fiche Absence suit l'état reçu, sauf pendant une saisie.
  if (absenceDialog.open && !state.absenceBusy && !absenceDialog.contains(document.activeElement)) renderAbsence();

  $("banner").hidden = !state.error;
  $("banner").textContent = state.error ?? "";
  $("updated").textContent = state.updatedAt
    ? `Données à jour à ${new Date(state.updatedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}, relues toutes les 20 s quand l'écran est ouvert.`
    : "";

  if (state.sheetRoom !== null) renderSheet();
}

/* ---------- Connexion et démarrage ---------- */

let pollTimer = null;

const signin = createSignin({
  subtitle: "Vos climatiseurs, pièce par pièce",
  extra: el("p", { class: "small muted" }, [
    "Première installation ? Créez votre clé depuis ",
    el("a", { href: "/diagnostic" }, "le diagnostic"),
    ".",
  ]),
  onSignedIn: start,
});
document.body.prepend(signin.node);

function showSignin(message) {
  clearInterval(pollTimer);
  for (const dialog of [sheet, $("more"), absenceDialog]) if (dialog.open) dialog.close();
  $("app").hidden = true;
  updateThemeColor(null);
  signin.show(message);
}

function start(name) {
  signin.hide();
  $("app").hidden = false;
  $("who").textContent = `Connecté en tant que ${name}.`;
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden) refresh();
    else render(); // fait expirer les messages et valeurs en attente
  }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !$("app").hidden) refresh();
});

for (const dialog of [sheet, $("more"), absenceDialog]) enableDismiss(dialog);

$("ribbon").addEventListener("click", () => {
  if ($("ribbon").dataset.kind === "absence") return openAbsence();
  if (state.active !== null) openSheet(state.active, "program");
});
$("power").append(icon("power"));
$("power").addEventListener("click", () => state.active !== null && togglePower(state.active));
$("open-absence-top").append(icon("bag"));
$("open-absence-top").addEventListener("click", openAbsence);
$("open-more").append(icon("more"));
$("open-more").addEventListener("click", () => $("more").showModal());
$("more").querySelector("[data-close]").addEventListener("click", () => $("more").close());
$("refresh").addEventListener("click", refresh);
$("open-absence").addEventListener("click", openAbsence);
$("signout").addEventListener("click", async () => {
  try {
    await signOut();
    showSignin();
  } catch (err) {
    $("who").textContent = `Déconnexion impossible : ${err.message}`;
  }
});

api("GET", "/api/me")
  .then((me) => start(me.name))
  .catch((err) => showSignin(err.status === 401 ? null : err.message));
