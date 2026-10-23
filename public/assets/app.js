/**
 * Tableau de bord Cocon : une pièce par panneau, une fiche de réglages par pièce.
 *
 * - L'état vient de GET /api/state, relu toutes les 20 s quand l'appli est
 *   visible (et aussitôt quand on y revient).
 * - Chaque commande part vers POST /api/rooms/<id>. La valeur demandée s'affiche
 *   tout de suite ; elle reste affichée jusqu'à ce qu'Atlantic la renvoie (90 s max).
 * - Une seule commande à la fois par pièce ; la consigne part 1,2 s après le
 *   dernier appui sur + ou −.
 */

import { api, el } from "./api.js";
import {
  applyOptimistic,
  conflictWith,
  describeOutcome,
  formatTemperature,
  powerOnMode,
  stepSetpoint,
} from "./logic.js";
import { createSignin, signOut } from "./session.js";
import { chip, icon, option } from "./ui.js";
import { editorView, openEditor, programGroup, programLine, reloadEditor } from "./program-editor.js";
import { absenceText, absenceView, newAbsenceForm } from "./absence-view.js";

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
const MODE_ORDER = ["heat", "cool", "auto", "dry", "fan", "off"];
const FAN_LABEL = { auto: "Auto", low: "Basse", medium: "Moyenne", high: "Haute", quiet: "Silence" };
const ADJUSTABLE = new Set(["heat", "cool", "auto", "dry"]);

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
  drafts: new Map(), // id → minuterie de la consigne en cours de réglage
  confirmMode: null, // { id, mode } : mode en conflit qui attend une confirmation
  sheetRoom: null, // pièce dont la fiche est ouverte
  editor: null, // éditeur de programme ouvert dans la fiche (voir program-editor.js)
  absence: null, // état de l'absence renvoyé par le relais
  absenceForm: null, // formulaire de la fiche Absence
  absenceBusy: false,
  absenceStatus: null, // { kind, text, at }
};

const roomById = (id) => state.view.find((r) => r.id === id);

/* Dernier mode utilisé par pièce : simple confort, propre à ce téléphone. */
function rememberMode(id, mode) {
  if (!mode || mode === "off" || mode === "unknown") return;
  try {
    localStorage.setItem(`cocon.lastMode.${id}`, mode);
  } catch {
    /* stockage indisponible : on retombera sur la saison */
  }
}

function rememberedMode(id) {
  try {
    return localStorage.getItem(`cocon.lastMode.${id}`);
  } catch {
    return null;
  }
}

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

/** + / − : la consigne s'affiche aussitôt et part après le dernier appui. */
function nudge(id, direction) {
  const room = roomById(id);
  if (!room || state.busy.has(id)) return;
  const next = stepSetpoint(room, direction);
  if (next === null || next === room.setpoint) return;
  setOptimistic(id, { setpoint: next });
  setStatus(id, "draft", `Consigne ${formatTemperature(next)}, envoi dans un instant…`);
  clearTimeout(state.drafts.get(id));
  state.drafts.set(
    id,
    setTimeout(() => {
      state.drafts.delete(id);
      const current = roomById(id);
      if (current) send(current, "setpoint", next, { setpoint: next });
    }, SETPOINT_DEBOUNCE_MS),
  );
  render();
}

function chooseMode(id, mode) {
  const room = roomById(id);
  if (!room || room.mode === mode) return;
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
    return;
  }
  send(room, "mode", mode, { mode });
}

function togglePower(id) {
  const room = roomById(id);
  if (!room) return;
  if (room.mode !== "off") return send(room, "mode", "off", { mode: "off" });
  const mode = powerOnMode(room, rememberedMode(id), new Date().getMonth());
  if (mode) chooseMode(id, mode);
}

/* ---------- Panneaux ---------- */

const panes = new Map(); // id → { node, update(room) }

function createPane(id) {
  const name = el("h2", { class: "pane__name", id: `room-${id}` });
  const stateLabel = el("p", { class: "pane__state" });
  const setpoint = el("p", { class: "setpoint" });
  const measured = el("p", { class: "measured" });
  const programInfo = el("p", { class: "pane__program" });
  const note = el("p", { class: "pane__note" });

  const minus = el("button", { class: "round", type: "button", onclick: () => nudge(id, -1) }, icon("minus"));
  const plus = el("button", { class: "round", type: "button", onclick: () => nudge(id, +1) }, icon("plus"));
  const off = el("button", { class: "round", type: "button", onclick: () => togglePower(id) }, icon("power"));
  const on = el("button", { class: "button button--solid", type: "button", onclick: () => togglePower(id) }, [
    icon("power"),
    el("span"),
  ]);
  const settings = el("button", { class: "button", type: "button", onclick: () => openSheet(id) }, [
    icon("sliders"),
    "Réglages",
  ]);
  const status = el("p", { class: "pane__status", "aria-live": "polite" });

  const node = el("section", { class: "pane", "aria-labelledby": `room-${id}` }, [
    el("div", { class: "pane__head" }, [name, stateLabel]),
    el("div", { class: "pane__body" }, [setpoint, measured, programInfo, note]),
    el("div", {}, [
      el("div", { class: "pane__controls" }, [minus, plus, off, on, el("span", { class: "spacer" }), settings]),
      status,
    ]),
  ]);

  function update(room) {
    const busy = state.busy.has(id);
    const active = room.available && room.mode !== "off" && room.mode !== "unknown";
    node.dataset.mode = room.available ? room.mode : "off";
    node.toggleAttribute("data-active", active);

    name.textContent = room.name;
    stateLabel.textContent = room.available ? MODE_LABEL[room.mode] : "Hors ligne";

    // Le grand chiffre : la consigne (ou, en ventilation seule, la température).
    if (room.mode === "fan") {
      setpoint.textContent = formatTemperature(room.temperature);
      measured.textContent = "Ventilation seule, sans consigne";
    } else {
      setpoint.textContent = formatTemperature(room.setpoint);
      measured.textContent =
        room.temperature !== null
          ? `Il fait ${formatTemperature(room.temperature)} dans la pièce`
          : "Température de la pièce indisponible";
    }
    setpoint.toggleAttribute("data-draft", state.drafts.has(id));
    if (room.mode === "fan" || room.setpoint === null) setpoint.removeAttribute("aria-label");
    else setpoint.setAttribute("aria-label", `Consigne ${formatTemperature(room.setpoint).replace("°", " degrés")}`);

    const line = room.available ? programLine(room) : null;
    programInfo.hidden = !line;
    programInfo.textContent = line ?? "";

    const conflict = active ? conflictWith(state.view, id, room.mode) : null;
    note.hidden = !conflict;
    if (conflict) {
      note.textContent = `${conflict.name} est en ${MODE_LABEL[conflict.mode].toLowerCase()} : une seule unité extérieure ne peut pas chauffer et refroidir en même temps.`;
    }

    const adjustable = active && ADJUSTABLE.has(room.mode) && room.setpointRange;
    minus.hidden = plus.hidden = !adjustable;
    minus.disabled = plus.disabled = busy;
    minus.setAttribute("aria-label", `Baisser la consigne de ${room.name}`);
    plus.setAttribute("aria-label", `Monter la consigne de ${room.name}`);

    off.hidden = !active;
    off.disabled = busy;
    off.setAttribute("aria-label", `Éteindre ${room.name}`);

    const onMode = powerOnMode(room, rememberedMode(id), new Date().getMonth());
    on.hidden = active || !room.available || !onMode;
    on.disabled = busy;
    on.lastChild.textContent = "Allumer";
    on.setAttribute("aria-label", onMode ? `Allumer ${room.name} en ${MODE_LABEL[onMode].toLowerCase()}` : `Allumer ${room.name}`);

    settings.disabled = !room.available;
    settings.setAttribute("aria-label", `Réglages de ${room.name}`);

    const current = state.status.get(id);
    const visible = current && (current.kind === "sending" || current.kind === "draft" || Date.now() - current.at < STATUS_VISIBLE_MS);
    let idle = "";
    if (!room.available) idle = "Unité injoignable : vérifiez le hub Cozytouch.";
    else if (!active && onMode) idle = `Se rallumera en ${MODE_LABEL[onMode].toLowerCase()}`;
    status.dataset.kind = visible ? current.kind : "";
    status.replaceChildren(
      ...(visible && (current.kind === "sending" || current.kind === "draft")
        ? [el("span", { class: "spinner", "aria-hidden": "true" })]
        : []),
      visible ? current.text : idle,
    );
  }

  return { node, update };
}

/* ---------- Fiche de réglages ---------- */

const sheet = $("sheet");

let sheetSignature = null;

function renderSheet() {
  const room = roomById(state.sheetRoom);
  if (!room) return sheet.open && sheet.close();
  const id = room.id;
  const busy = state.busy.has(id) || !room.available;
  const current = state.status.get(id);

  // On ne reconstruit la fiche que si son contenu change (le rafraîchissement
  // toutes les 20 s ne doit pas voler un appui en cours).
  const signature = JSON.stringify([room, busy, current, state.confirmMode, state.editor, state.view.map((r) => r.mode)]);
  if (signature === sheetSignature && sheet.childElementCount) return;
  sheetSignature = signature;

  // L'encadré d'alerte remplace le message de confirmation dans la fiche.
  const visible =
    current &&
    current.kind !== "confirm" &&
    (current.kind === "sending" || current.kind === "draft" || Date.now() - current.at < STATUS_VISIBLE_MS);
  const status = el("p", { class: "sheet__status", "aria-live": "polite", "data-kind": visible ? current.kind : "" }, [
    visible && (current.kind === "sending" || current.kind === "draft")
      ? el("span", { class: "spinner", "aria-hidden": "true" })
      : null,
    visible ? current.text : room.available ? `${MODE_LABEL[room.mode]}, ${room.temperature !== null ? `il fait ${formatTemperature(room.temperature)}` : "température indisponible"}` : "Unité hors ligne : réglages indisponibles.",
  ]);

  if (state.editor?.roomId === id && room.program) {
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
    sheet.replaceChildren(view.head, el("div", { class: "sheet__body" }, view.body));
    return;
  }

  const groups = [];

  const pending = state.confirmMode?.id === id ? state.confirmMode.mode : null;
  const conflict = pending ? conflictWith(state.view, id, pending) : null;
  if (conflict) {
    groups.push(
      el(
        "p",
        { class: "warning", role: "alert" },
        `${conflict.name} est en ${MODE_LABEL[conflict.mode].toLowerCase()}. Avec une seule unité extérieure, l'une des deux pièces restera en attente. Touchez à nouveau « ${MODE_LABEL[pending]} » pour confirmer.`,
      ),
    );
  }

  groups.push(
    el("section", { class: "group" }, [
      el("h3", {}, "Mode"),
      el(
        "div",
        { class: "chips" },
        MODE_ORDER.filter((m) => room.modes.includes(m)).map((mode) =>
          chip(MODE_LABEL[mode], {
            pressed: room.mode === mode,
            confirm: pending === mode,
            disabled: busy,
            onclick: () => chooseMode(id, mode),
          }),
        ),
      ),
    ]),
  );

  if (ADJUSTABLE.has(room.mode) && room.setpointRange) {
    groups.push(
      el("section", { class: "group" }, [
        el("h3", {}, "Consigne"),
        el("div", { class: "stepper" }, [
          el(
            "button",
            { class: "round", type: "button", "aria-label": "Baisser la consigne", disabled: busy, onclick: () => nudge(id, -1) },
            icon("minus"),
          ),
          el("span", { class: "stepper__value", "aria-live": "polite" }, formatTemperature(room.setpoint)),
          el(
            "button",
            { class: "round", type: "button", "aria-label": "Monter la consigne", disabled: busy, onclick: () => nudge(id, +1) },
            icon("plus"),
          ),
        ]),
        el(
          "p",
          { class: "group__help" },
          `De ${formatTemperature(room.setpointRange.min)} à ${formatTemperature(room.setpointRange.max)}, par pas de ${formatTemperature(room.setpointRange.step)}`,
        ),
      ]),
    );
  }

  if (room.program) {
    groups.push(
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

  if (room.fanSpeeds?.length) {
    groups.push(
      el("section", { class: "group" }, [
        el("h3", {}, "Ventilation"),
        el(
          "div",
          { class: "chips chips--compact" },
          room.fanSpeeds.map((speed) =>
            chip(FAN_LABEL[speed], {
              pressed: room.fan === speed,
              disabled: busy,
              onclick: () => room.fan !== speed && send(room, "fan", speed, { fan: speed }),
            }),
          ),
        ),
      ]),
    );
  }

  if (room.louvers?.length) {
    const positions = room.louvers.filter((l) => l !== "swing");
    groups.push(
      el("section", { class: "group" }, [
        el("h3", {}, "Volets"),
        room.louvers.includes("swing")
          ? chip("Balayage", {
              pressed: room.louver === "swing",
              disabled: busy,
              onclick: () => room.louver !== "swing" && send(room, "louver", "swing", { louver: "swing" }),
            })
          : null,
        el(
          "div",
          { class: "chips chips--positions" },
          positions.map((position) =>
            chip(position, {
              pressed: room.louver === position,
              disabled: busy,
              onclick: () => room.louver !== position && send(room, "louver", position, { louver: position }),
            }),
          ),
        ),
        el(
          "p",
          { class: "group__help" },
          `Position fixe, de 1 (le plus haut) à ${positions.length} (le plus bas).`,
        ),
      ]),
    );
  }

  const options = [];
  if (room.powerful !== undefined) {
    options.push(
      option("Pleine puissance", "L'unité fonctionne à sa puissance maximale.", room.powerful, busy, () =>
        send(room, "powerful", !room.powerful, { powerful: !room.powerful }),
      ),
    );
  }
  if (room.economy !== undefined) {
    options.push(
      option(
        "Économie d'énergie",
        "Limite la puissance de l'unité pour consommer moins. Coupez-la pour chauffer ou refroidir plus vite.",
        room.economy,
        busy,
        () => send(room, "economy", !room.economy, { economy: !room.economy }),
      ),
    );
  }
  if (options.length) groups.push(el("section", { class: "group" }, [el("h3", {}, "Options"), ...options]));

  sheet.replaceChildren(
    el("div", { class: "sheet__head" }, [
      el("h2", { id: "sheet-title" }, room.name),
      el("span", { class: "spacer" }),
      el("button", { class: "button button--quiet", type: "button", onclick: () => sheet.close() }, "Fermer"),
    ]),
    el("div", { class: "sheet__body" }, [status, ...groups]),
  );
}

function openSheet(id) {
  state.sheetRoom = id;
  state.confirmMode = null;
  sheetSignature = null;
  renderSheet();
  if (!sheet.open) sheet.showModal();
}

sheet.addEventListener("close", () => {
  state.sheetRoom = null;
  state.confirmMode = null;
  state.editor = null;
});

// Toucher le fond assombri ferme la fiche.
for (const dialog of [sheet, $("more"), $("absence")]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
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
  absenceDialog.replaceChildren(view.head, el("div", { class: "sheet__body" }, view.body));
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

  const container = $("rooms");
  if (state.updatedAt === null) {
    $("loading").hidden = Boolean(state.error);
  } else if (state.view.length === 0) {
    container.replaceChildren(
      el("div", { class: "empty stack" }, [
        el("p", {}, "Aucune pièce climatisée n'a été trouvée sur ce compte Cozytouch."),
        el("a", { class: "button", href: "/diagnostic" }, "Ouvrir le diagnostic"),
      ]),
    );
  } else {
    for (const room of state.view) {
      if (!panes.has(room.id)) panes.set(room.id, createPane(room.id));
      panes.get(room.id).update(room);
    }
    const nodes = state.view.map((room) => panes.get(room.id).node);
    if (nodes.some((node, i) => container.children[i] !== node) || container.children.length !== nodes.length) {
      container.replaceChildren(...nodes);
    }
  }

  const absence = absenceText(state.absence);
  $("absence-banner").hidden = !absence;
  $("absence-text").textContent = absence ?? "";
  // La fiche Absence suit l'état reçu, sauf pendant une saisie.
  if (absenceDialog.open && !state.absenceBusy && !absenceDialog.contains(document.activeElement)) renderAbsence();

  $("banner").hidden = !state.error;
  $("banner").textContent = state.error ?? "";
  $("updated").textContent = state.updatedAt
    ? `À jour à ${new Date(state.updatedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
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
  if (sheet.open) sheet.close();
  if ($("more").open) $("more").close();
  if (absenceDialog.open) absenceDialog.close();
  $("app").hidden = true;
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

$("refresh").append(icon("refresh"));
$("refresh").addEventListener("click", refresh);
$("open-more").append(icon("more"));
$("open-more").addEventListener("click", () => $("more").showModal());
$("more").querySelector("[data-close]").addEventListener("click", () => $("more").close());
$("open-absence").addEventListener("click", openAbsence);
$("absence-edit").addEventListener("click", openAbsence);
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
