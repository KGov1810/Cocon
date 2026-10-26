/**
 * Tests dans un vrai navigateur (Chromium), contre le serveur d'essai :
 *   npm run e2e
 *
 * 1. Parcours complet du tableau de bord (gestes, panneaux, absence,
 *    programme, marche/arrêt, clavier, déconnexion).
 * 2. Mise en page : petit écran, grand écran, animations réduites.
 * 3. Accessibilité (axe-core) sur chaque écran, en clair et en sombre.
 *
 * Le script s'arrête au premier échec et l'explique ; il renvoie un code
 * d'erreur pour pouvoir servir dans une vérification automatique.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright";

import { ACCESS_KEY, startServer } from "./server.mjs";

const AXE = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const CONFIRMED = { timeout: 15_000 };

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    throw err;
  }
}

/** Nouvelle page qui note toute erreur JavaScript ou console. */
async function openPage(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR", ...options });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (err) => page.errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && !msg.text().includes("401") && page.errors.push(msg.text()));
  return page;
}

async function signIn(page, url) {
  await page.goto(url);
  await page.fill("#access-key", ACCESS_KEY);
  await page.click("button[type=submit]");
  await page.waitForSelector("#dial:not([hidden])");
  await page.waitForTimeout(500);
}

/** Glisse le doigt (souris) de (x0, y0) à (x1, y1), relatif au chiffre. */
async function drag(page, x0, y0, x1, y1, steps = 12) {
  const box = await page.locator("#dial").boundingBox();
  await page.mouse.move(box.x + x0, box.y + y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(box.x + x0 + ((x1 - x0) * i) / steps, box.y + y0 + ((y1 - y0) * i) / steps);
    await page.waitForTimeout(16);
  }
}

const shown = async (page) => (await page.textContent("#dial-whole")) + (await page.textContent("#dial-decimal"));
const text = (page, selector) => page.locator(selector).first().innerText();
const activeRoom = (page) => page.getAttribute("#tabs .tab[aria-pressed=true]", "aria-label");
const waitConfirmed = (page, selector = "#send-line") =>
  page.locator(selector).filter({ hasText: "Confirmé" }).waitFor(CONFIRMED);

async function openTile(page, index) {
  await page.locator("#tiles .tile").nth(index).click();
  await page.waitForSelector("dialog#sheet[open]");
  await page.waitForTimeout(400);
}

/* ---------- 1. Parcours complet ---------- */

async function journey(browser, url) {
  console.log("Parcours complet");
  const page = await openPage(browser);
  await signIn(page, url);

  await step("connexion et pièce affichée", async () => {
    assert.equal(await page.locator("#tabs .tab").count(), 2);
    assert.notEqual(await page.getAttribute("#app", "data-mode"), "off");
  });

  await step("barre d'état de la couleur du mode", async () => {
    const colors = await page.evaluate(() => {
      const scene = getComputedStyle(document.getElementById("app")).getPropertyValue("--scene-bg").trim();
      return { scene, metas: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content) };
    });
    assert.deepEqual(colors.metas, [colors.scene, colors.scene]);
  });

  await step("glisser vers le haut envoie la consigne", async () => {
    const before = await shown(page);
    await drag(page, 195, 260, 195, 214);
    assert.match(await text(page, "#dial-hint"), /relâchez pour envoyer/);
    await page.mouse.up();
    assert.notEqual(await shown(page), before);
    await waitConfirmed(page);
  });

  await step("élastique au-delà du maximum", async () => {
    await drag(page, 195, 300, 195, -400, 24);
    assert.match(await text(page, "#dial-hint"), /^Maximum/);
    await page.mouse.up();
    await waitConfirmed(page);
  });

  await step("glisser de côté change de pièce", async () => {
    const before = await activeRoom(page);
    await drag(page, 300, 200, 150, 205, 6);
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.notEqual(await activeRoom(page), before);
  });

  await step("panneau Mode : alerte chaud contre froid", async () => {
    await openTile(page, 0);
    assert.match(await text(page, "#sheet-title"), /^Mode/);
    await page.locator("#sheet .chip", { hasText: "Froid" }).click();
    await page.waitForTimeout(300);
    assert.ok(await page.isVisible("dialog#sheet[open]"), "le panneau doit rester ouvert");
    assert.equal(await page.locator("#sheet .warning").count(), 1);
    await page.locator("#sheet button", { hasText: "Fermer" }).click();
  });

  await step("panneau Volets : un choix envoie et ferme", async () => {
    await openTile(page, 2);
    await page.locator("#sheet .chip", { hasText: "Position 2" }).click();
    await page.waitForTimeout(300);
    assert.ok(!(await page.isVisible("dialog#sheet[open]")));
    assert.match(await page.locator("#tiles .tile").nth(2).innerText(), /Pos\. 2/);
    await waitConfirmed(page);
  });

  await step("panneau Options : un appui ne ferme pas, un grand tirage ferme", async () => {
    await openTile(page, 3);
    await page.click("#sheet-title");
    await page.waitForTimeout(200);
    assert.ok(await page.isVisible("dialog#sheet[open]"), "appui sur le titre");
    const grab = await page.locator("#sheet .sheet__grab").boundingBox();
    const x = grab.x + grab.width / 2;
    await page.mouse.move(x, grab.y + 10);
    await page.mouse.down();
    for (let i = 1; i <= 5; i += 1) {
      await page.mouse.move(x, grab.y + 10 + 8 * i);
      await page.waitForTimeout(60);
    }
    await page.mouse.up();
    await page.waitForTimeout(350);
    assert.ok(await page.isVisible("dialog#sheet[open]"), "petit tirage lent");
    await page.mouse.move(x, grab.y + 10);
    await page.mouse.down();
    for (let i = 1; i <= 7; i += 1) {
      await page.mouse.move(x, grab.y + 10 + 30 * i);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.ok(!(await page.isVisible("dialog#sheet[open]")), "grand tirage");
  });

  await step("programme : éditeur et retour", async () => {
    await page.click("#ribbon");
    await page.waitForSelector("dialog#sheet[open]");
    await page.locator("#sheet button", { hasText: "Modifier le programme" }).click();
    const back = page.locator("#sheet .sheet__head .icon-button");
    assert.equal(await back.getAttribute("aria-label"), "Retour au programme");
    await back.click();
    assert.match(await text(page, "#sheet-title"), /^Programme/);
    await page.locator("#sheet button", { hasText: "Fermer" }).click();
  });

  await step("absence : programmer puis annuler", async () => {
    await page.click("#open-absence-top");
    await page.waitForSelector("dialog#absence[open]");
    assert.ok(await page.locator("#absence .sheet__status").isHidden(), "ligne d'état vide masquée");
    await page.locator("#absence button", { hasText: "Programmer l'absence" }).click();
    await waitConfirmed(page, "#absence .sheet__status");
    await page.locator("#absence button", { hasText: "Fermer" }).click();
    await page.locator("#ribbon-text", { hasText: "Absence en cours" }).waitFor(CONFIRMED);
    assert.equal(await page.getAttribute("#app", "data-mode"), "off");
    assert.equal(await text(page, "#status-line"), "Arrêtée pendant l'absence");
    await page.click("#ribbon");
    await page.waitForSelector("dialog#absence[open]");
    await page.locator("#absence button", { hasText: "Annuler l'absence" }).click();
    await waitConfirmed(page, "#absence .sheet__status");
    await page.locator("#absence button", { hasText: "Fermer" }).click();
    await page.locator("#ribbon-text", { hasNotText: "Absence" }).waitFor(CONFIRMED);
  });

  await step("rallumer une pièce arrêtée", async () => {
    assert.equal(await page.getAttribute("#app", "data-mode"), "off");
    await page.click("#power");
    await waitConfirmed(page);
    assert.notEqual(await page.getAttribute("#app", "data-mode"), "off");
  });

  await step("clavier : le curseur règle et envoie la consigne", async () => {
    await page.waitForTimeout(500);
    await page.focus("#setpoint");
    const before = Number(await page.inputValue("#setpoint"));
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    assert.equal(Number(await page.inputValue("#setpoint")), before + 1);
    assert.match(await text(page, "#send-line"), /Envoi dans un instant/);
    await waitConfirmed(page);
  });

  await step("clavier pendant un envoi : message et consigne inchangée", async () => {
    await page.waitForTimeout(500);
    const before = await page.inputValue("#setpoint");
    await openTile(page, 1);
    await page.locator("#sheet .chip[aria-pressed=false]").first().click();
    await page.focus("#setpoint");
    await page.keyboard.press("ArrowUp");
    assert.match(await text(page, "#send-line"), /déjà en cours/);
    assert.equal(await page.inputValue("#setpoint"), before);
    assert.equal((await shown(page)).replace(",", "."), String(Number(before)));
    await page.waitForTimeout(2500);
  });

  await step("menu « … » : actualiser, diagnostic, déconnexion", async () => {
    await page.click("#open-more");
    await page.waitForSelector("dialog#more[open]");
    const items = (await page.locator("#more .sheet__body > *").allInnerTexts()).map((t) => t.trim());
    assert.deepEqual(items, ["Connecté en tant que Essai.", "Actualiser maintenant", "Ouvrir le diagnostic", "Se déconnecter"]);
  });

  await step("déconnexion : écran de connexion et barre d'état d'origine", async () => {
    await page.click("#signout");
    await page.waitForSelector("#access-key");
    assert.ok(await page.isHidden("#app"));
    const metas = await page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content));
    assert.deepEqual(metas, ["#e8ecea", "#0d141a"]);
  });

  await step("aucune erreur dans la console", async () => assert.deepEqual(page.errors, []));
  await page.context().close();
}

/* ---------- 2. Mise en page ---------- */

async function layouts(browser, url) {
  console.log("Mise en page");
  const cases = [
    ["petit écran (375 × 667)", { viewport: { width: 375, height: 667 } }],
    ["grand écran (1280 × 800)", { viewport: { width: 1280, height: 800 } }],
    ["animations réduites", { reducedMotion: "reduce" }],
  ];
  for (const [name, options] of cases) {
    await step(`${name} : tient dans l'écran, sans erreur`, async () => {
      const page = await openPage(browser, options);
      await signIn(page, url);
      const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, inner: innerHeight }));
      assert.equal(scroll, inner);
      assert.deepEqual(page.errors, []);
      await page.context().close();
    });
  }
}

/* ---------- 3. Accessibilité ---------- */

async function accessibility(browser, url) {
  for (const colorScheme of ["light", "dark"]) {
    console.log(`Accessibilité (${colorScheme === "light" ? "clair" : "sombre"})`);
    // La politique de sécurité bloque les scripts ajoutés : on l'écarte pour ce seul outil.
    const page = await openPage(browser, { colorScheme, bypassCSP: true });
    const audit = (name) =>
      step(`${name} : aucun problème`, async () => {
        await page.addScriptTag({ content: AXE });
        const violations = await page.evaluate(async () =>
          (await window.axe.run(document, { resultTypes: ["violations"] })).violations.map(
            (v) => `${v.id} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
          ),
        );
        assert.deepEqual(violations, []);
      });
    const sheet = async (name, open) => {
      await open();
      await page.waitForSelector("dialog[open]");
      await page.waitForTimeout(400);
      await audit(name);
      await page.keyboard.press("Escape"); // ferme le panneau (dialogue natif)
      await page.waitForTimeout(300);
    };

    await page.goto(url);
    await page.waitForSelector("#access-key");
    await audit("connexion");
    await signIn(page, url);
    await audit("accueil");
    await page.locator("#tabs .tab").nth(1).click();
    await page.waitForTimeout(400);
    await audit("accueil, autre pièce");
    for (const [index, name] of ["Mode", "Vitesse", "Volets", "Options"].entries()) {
      await sheet(`panneau ${name}`, () => page.locator("#tiles .tile").nth(index).click());
    }
    await sheet("éditeur de programme", async () => {
      await page.click("#ribbon");
      await page.locator("#sheet button", { hasText: "Modifier le programme" }).click();
    });
    await sheet("absence", () => page.click("#open-absence-top"));
    await sheet("menu « … »", () => page.click("#open-more"));
    await page.goto(`${url}/diagnostic`);
    await page.waitForSelector("#report:not([hidden])");
    await audit("diagnostic");
    await page.context().close();
  }
}

/* ---------- Lancement ---------- */

const server = await startServer();
const browser = await chromium.launch();
let failed = false;
try {
  await journey(browser, server.url);
  await layouts(browser, server.url);
  await accessibility(browser, server.url);
  console.log(`\n${passed} vérifications réussies.`);
} catch (err) {
  failed = true;
  console.error(`\n${err.message}`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
