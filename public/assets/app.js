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
import { MODE_LABEL, applyOptimistic, conflictWith, describeOutcome, powerOnMode, shownStatus } from "./logic.js";
import { createSignin, signOut } from "./session.js";
import { enableSheetDismiss, icon, sheetGrab, sheetStatus } from "./ui.js";
import { editorView, openEditor, reloadEditor } from "./program-editor.js";
import { absenceView, newAbsenceForm } from "./absence-view.js";
import { createRoomView } from "./room-view.js";
import { settingsView } from "./settings-view.js";

const POLL_MS = 20_000;
const OPTIMISTIC_MS = 90_000;
const SETPOINT_DEBOUNCE_MS = 1200;
const BUSY_TEXT = "Une commande est déjà en cours pour cette pièce : réessayez dans un instant.";

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
    setStatus(id, "error", BUSY_TEXT);
    return render();
  }
  if (value !== room.setpoint) send(room, "setpoint", value, { setpoint: value });
  else render();
}

/** Curseur natif (clavier, VoiceOver) : la consigne part après le dernier réglage. */
function draftSetpoint(id, value) {
  const room = roomById(id);
  if (!room) return;
  if (state.busy.has(id)) {
    // Comme au doigt : on le dit, et le chiffre revient à la consigne actuelle.
    setStatus(id, "error", BUSY_TEXT);
    return render();
  }
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

const onModeFor = (room) => powerOnMode(room, rememberedMode(room.id), new Date().getMonth());

function togglePower(id) {
  const room = roomById(id);
  if (!room) return;
  if (room.mode !== "off") return send(room, "mode", "off", { mode: "off" });
  const mode = onModeFor(room);
  if (!mode) return;
  // En conflit, la confirmation se fait dans le panneau Mode.
  if (conflictWith(state.view, id, mode)) openSheet(id, "mode");
  chooseMode(id, mode);
}

function selectRoom(id, from) {
  if (id === state.active) return;
  state.active = id;
  remember("cocon.room", String(id));
  render();
  roomView.slideIn(from);
}

/* ---------- Écran de la pièce ---------- */

const roomView = createRoomView({
  onSelect: selectRoom,
  onCommit: commitSetpoint,
  onDraft: draftSetpoint,
  onOpen: openSheet,
  onPower: togglePower,
  onAbsence: openAbsence,
});

function renderRoom() {
  $("loading").hidden = state.updatedAt !== null || Boolean(state.error);
  $("empty").hidden = state.updatedAt === null || state.view.length > 0;
  if (!state.view.length) return roomView.clear();

  if (!roomById(state.active)) {
    const stored = Number(recall("cocon.room"));
    state.active = roomById(stored) ? stored : state.view[0].id;
  }
  const room = roomById(state.active);
  roomView.update({
    rooms: state.view,
    room,
    absence: state.absence,
    busy: state.busy.has(room.id),
    status: shownStatus(state.status.get(room.id), Date.now()),
    updatedAt: state.updatedAt,
    onMode: room.mode === "off" ? onModeFor(room) : null,
  });
}

/* ---------- Panneaux de réglages ---------- */

const sheet = $("sheet");

let sheetSignature = null;

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

  // Dans le panneau, l'encadré d'alerte remplace le message de confirmation.
  const shown = current?.kind === "confirm" ? null : shownStatus(current, Date.now());
  const status = sheetStatus(shown, room.available ? null : "Unité hors ligne : réglages indisponibles.");

  const view =
    kind === "program" && state.editor?.roomId === id && room.program
      ? editorView(room, state.editor, {
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
        })
      : settingsView(room, kind, {
          rooms: state.view,
          busy,
          status,
          pendingMode: state.confirmMode?.id === id ? state.confirmMode.mode : null,
          send: (setting, value, patch) => send(room, setting, value, patch),
          chooseMode: (mode) => chooseMode(id, mode),
          onEdit: () => {
            state.editor = openEditor(room);
            renderSheet();
          },
          onClose: () => sheet.close(),
        });
  sheet.replaceChildren(sheetGrab(), view.head, el("div", { class: "sheet__body" }, view.body));
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

/* ---------- Absence ---------- */

const absenceDialog = $("absence");

function renderAbsence() {
  const view = absenceView(state.absence, state.absenceForm, {
    busy: state.absenceBusy,
    status: sheetStatus(state.absenceStatus),
    onChange: (patch) => {
      state.absenceForm = { ...state.absenceForm, ...patch };
      renderAbsence();
    },
    onSubmit: (window) => sendAbsence(window),
    onCancelAbsence: () => sendAbsence(null),
    onClose: () => absenceDialog.close(),
  });
  absenceDialog.replaceChildren(sheetGrab(), view.head, el("div", { class: "sheet__body" }, view.body));
}

function openAbsence() {
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
  // Sans hub Cozytouch lisible, pas d'absence à programmer.
  $("open-absence-top").hidden = state.absence?.available === false;

  // La fiche Absence suit l'état reçu, sauf pendant une saisie.
  if (absenceDialog.open && !state.absenceBusy && !absenceDialog.contains(document.activeElement)) renderAbsence();

  $("banner").hidden = !state.error;
  $("banner").textContent = state.error ?? "";

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
  roomView.clear();
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

for (const dialog of [sheet, $("more"), absenceDialog]) enableSheetDismiss(dialog);

$("open-absence-top").append(icon("bag"));
$("open-absence-top").addEventListener("click", openAbsence);
$("open-more").append(icon("more"));
$("open-more").addEventListener("click", () => $("more").showModal());
$("more").querySelector("[data-close]").addEventListener("click", () => $("more").close());
$("refresh").addEventListener("click", refresh);
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
