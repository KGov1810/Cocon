/**
 * Page de diagnostic : affiche ce que le compte Atlantic expose réellement,
 * et permet de copier le rapport (données sensibles déjà masquées par le relais).
 */

import { api, copyText, el, generateAccessKey } from "./api.js";
import { createSignin, signOut } from "./session.js";

const $ = (id) => document.getElementById(id);

let lastReport = null;

/* ---------- Connexion ---------- */

/** Outil de première installation : générer une clé d'accès. */
function keyGenerator() {
  const key = el("p", { class: "notice code" });
  const copy = el("button", { class: "button", type: "button" }, "Copier la clé");
  const result = el("div", { class: "stack stack--tight", hidden: true }, [key, copy]);

  copy.addEventListener("click", async () => {
    copy.textContent = (await copyText(key.textContent)) ? "Clé copiée" : "Sélectionnez la clé pour la copier";
  });

  const generate = el("button", { class: "button", type: "button" }, "Générer une clé");
  generate.addEventListener("click", () => {
    key.textContent = generateAccessKey();
    copy.textContent = "Copier la clé";
    result.hidden = false;
  });

  return el("details", { class: "card" }, [
    el("summary", {}, "Première installation : créer une clé"),
    el("div", { class: "stack details__body" }, [
      el("p", { class: "small muted" }, [
        "Chaque personne a sa propre clé. Générez-en une, puis ajoutez-la au secret ",
        el("span", { class: "code" }, "ACCESS_KEYS"),
        " dans Cloudflare sous la forme ",
        el("span", { class: "code" }, "Prénom:clé"),
        " (voir le README).",
      ]),
      generate,
      result,
    ]),
  ]);
}

const signin = createSignin({
  subtitle: "Diagnostic de votre installation",
  extra: keyGenerator(),
  onSignedIn: openReport,
});
document.body.prepend(signin.node);

function showSignin(message) {
  $("report-view").hidden = true;
  signin.show(message);
}

$("signout").addEventListener("click", async () => {
  try {
    await signOut();
    showSignin();
  } catch (err) {
    $("report-error").textContent = `Déconnexion impossible : ${err.message}`;
    $("report-error").hidden = false;
  }
});

/* ---------- Rapport ---------- */

function openReport(name) {
  signin.hide();
  $("report-view").hidden = false;
  $("who").textContent = name;
  loadReport();
}

async function loadReport() {
  $("loading").hidden = false;
  $("report-error").hidden = true;
  $("refresh").disabled = true;
  $("copy-report").disabled = true;
  $("report-text").hidden = true;
  $("copy-status").textContent = "";

  try {
    lastReport = await api("GET", "/api/diagnostic");
    renderReport(lastReport);
    $("copy-report").disabled = false;
  } catch (err) {
    if (err.status === 401) return showSignin(err.message);
    $("report-error").textContent = err.message;
    $("report-error").hidden = false;
  } finally {
    $("loading").hidden = true;
    $("refresh").disabled = false;
  }
}

$("refresh").addEventListener("click", loadReport);

$("copy-report").addEventListener("click", async () => {
  const text = JSON.stringify(lastReport, null, 2);
  if (await copyText(text)) {
    $("copy-status").textContent =
      "Rapport copié. Collez-le dans la conversation avec Claude.";
    return;
  }
  // Repli : on affiche le texte, prêt à être sélectionné à la main.
  const area = $("report-text");
  area.value = text;
  area.hidden = false;
  area.focus();
  area.select();
  $("copy-status").textContent = "Copie automatique refusée : sélectionnez le texte ci-dessous.";
});

function stat(label, value) {
  return el("div", { class: "stat" }, [
    el("span", { class: "stat__label" }, label),
    el("span", { class: "stat__value" }, value),
  ]);
}

function consumptionText(c) {
  if (c.available) return ["Disponible", "La route de consommation renvoie des données."];
  if (c.declared === false) {
    return ["Non disponible", "Aucune unité ne déclare de suivi de consommation."];
  }
  const detail = c.status === 200 ? "réponse vide" : `HTTP ${c.status ?? "—"}`;
  return ["Non disponible", `La route de consommation ne renvoie rien (${detail}).`];
}

function availability(device) {
  if (device.isAvailable === true) return el("span", { class: "badge badge--ok" }, "Connectée");
  if (device.isAvailable === false) return el("span", { class: "badge badge--warn" }, "Hors ligne");
  return null;
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function deviceCard(device, index) {
  const caps = device.capabilities ?? [];
  const model = [
    device.modelId != null ? `modèle ${device.modelId}` : null,
    device.productId != null ? `produit ${device.productId}` : null,
    device.zoneId != null ? `zone ${device.zoneId}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return el("section", { class: "card" }, [
    el("div", { class: "device__head" }, [
      el("h2", {}, device.name || `Appareil ${device.deviceId}`),
      availability(device),
    ]),
    el("p", { class: "small muted device__model" }, model || "—"),
    el("details", { open: index < 3 }, [
      el("summary", {}, `${caps.length} capacité${caps.length > 1 ? "s" : ""}`),
      el(
        "ul",
        { class: "caps" },
        caps.map((cap) =>
          el("li", {}, [
            el("span", { class: "id" }, `#${cap.capabilityId}`),
            el("span", { class: "name" }, cap.label ?? el("span", { class: "muted" }, "sans nom")),
            el("span", { class: "value" }, formatValue(cap.value)),
          ]),
        ),
      ),
    ]),
  ]);
}

function renderReport(report) {
  const container = $("report");
  const [consumptionLabel, consumptionDetail] = consumptionText(report.consumption);
  const devices = report.devices ?? [];
  const updated = new Date(report.generatedAt).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  container.replaceChildren(
    el("div", { class: "summary" }, [
      stat("Logement", report.account?.name ?? "—"),
      stat("Appareils", String(devices.length)),
      stat(
        "Quota Atlantic",
        report.account?.rateLimit != null ? `${report.account.rateLimit} req/min` : "—",
      ),
      stat("Consommation", consumptionLabel),
    ]),
    el("section", { class: "card stack stack--tight" }, [
      el("h2", {}, "Temps de réponse d'Atlantic"),
      el(
        "div",
        { class: "timings" },
        (report.timings ?? []).map((t) => el("span", { class: "badge" }, `${t.step} : ${t.ms} ms`)),
      ),
      el("p", { class: "small muted" }, `${consumptionDetail} Mis à jour à ${updated}.`),
    ]),
    ...devices.map(deviceCard),
  );
  container.hidden = false;
}

/* ---------- Démarrage ---------- */

// Une session encore ouverte (cookie) mène directement au rapport.
api("GET", "/api/me")
  .then((me) => openReport(me.name))
  .catch((err) => showSignin(err.status === 401 ? null : err.message));
