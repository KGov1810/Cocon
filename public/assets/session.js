/**
 * Écran de connexion, partagé par le tableau de bord et le diagnostic.
 *
 * La clé saisie part une seule fois vers /api/session ; le relais renvoie un
 * cookie HttpOnly que la page ne peut pas lire.
 */

import { api, el } from "./api.js";

/**
 * @param {object} options
 * @param {string} options.subtitle  phrase sous le nom de l'appli
 * @param {Node} [options.extra]     contenu ajouté sous le formulaire
 * @param {(name: string) => void} options.onSignedIn
 */
export function createSignin({ subtitle, extra, onSignedIn }) {
  const input = el("input", {
    id: "access-key",
    name: "access-key",
    type: "password",
    autocomplete: "current-password",
    autocapitalize: "none",
    autocorrect: "off",
    spellcheck: "false",
    enterkeyhint: "go",
    required: true,
  });
  const error = el("p", { class: "notice notice--error", role: "alert", hidden: true });
  const submit = el("button", { class: "button button--primary", type: "submit" }, "Se connecter");

  function show(message) {
    node.hidden = false;
    error.hidden = !message;
    error.textContent = message ?? "";
  }

  async function signIn(event) {
    event.preventDefault();
    const key = input.value.trim();
    if (!key) return show("Saisissez votre clé d'accès.");
    submit.disabled = true;
    try {
      const me = await api("POST", "/api/session", { key });
      input.value = "";
      node.hidden = true;
      onSignedIn(me.name);
    } catch (err) {
      show(err.message);
    } finally {
      submit.disabled = false;
    }
  }

  const node = el("main", { class: "page page--centered signin", hidden: true }, [
    el("div", { class: "stack" }, [
      el("div", { class: "stack stack--title" }, [
        el("h1", { class: "brand brand--large" }, "Cocon"),
        el("p", { class: "muted" }, subtitle),
      ]),
      el("form", { class: "card stack", novalidate: true, onsubmit: signIn }, [
        el("div", { class: "field" }, [el("label", { for: "access-key" }, "Votre clé d'accès"), input]),
        error,
        submit,
      ]),
      extra,
    ]),
  ]);

  return { node, show, hide: () => (node.hidden = true) };
}

/** Ferme la session côté relais (efface le cookie). */
export function signOut() {
  return api("DELETE", "/api/session");
}
