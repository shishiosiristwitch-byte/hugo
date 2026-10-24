// ── Version mobile : le téléphone interroge Ecole Directe lui-même (via /api/ed) ──
// Remplace le mini-serveur du PC : les appels /api/* du dashboard sont traités ici, dans le navigateur.
(() => {
  const LS = {
    get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const API_VERSION = "4.75.0", DAYS = 21, STALE_MS = 3 * 3600e3;

  // Clé du relais : fournie une fois dans le lien d'installation (?k=…), puis mémorisée et retirée de l'adresse
  const qs = new URLSearchParams(location.search);
  if (qs.get("k")) { LS.set("vs-key", qs.get("k")); qs.delete("k"); history.replaceState(null, "", location.pathname + (qs.toString() ? "?" + qs : "") + location.hash); }
  window.VS_DATA = LS.get("vs-data");

  const origFetch = window.fetch.bind(window);
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  const num = (v) => { const x = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(x) ? x : null; };
  const isoD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fr = (d) => new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  const f1 = (x) => (x == null ? "—" : x.toFixed(1).replace(".", ","));
  const htmlToText = (h) => { const d = new DOMParser().parseFromString(h.replace(/<br\s*\/?>|<\/p>|<\/li>/gi, " "), "text/html"); return (d.body.textContent || "").replace(/\s+/g, " ").trim(); };

  class NeedLogin extends Error {}

  // ── Client Ecole Directe (même logique que src/ecoledirecte/client.ts) ──
  let S = LS.get("vs-session") || {};
  let memCreds = null;
  const creds = () => memCreds || LS.get("vs-creds");
  const saveS = () => LS.set("vs-session", S);

  async function relay(path, data, get) {
    const key = LS.get("vs-key");
    if (!key) throw new Error("Clé d'accès absente : ouvrez une fois le lien d'installation complet (avec ?k=…).");
    let r;
    try {
      r = await origFetch("/api/ed", { method: "POST", headers: { "Content-Type": "application/json", "X-VS-Key": key },
        body: JSON.stringify({ path, data, get: !!get, v: API_VERSION, cookies: S.cookies || {}, token: S.token, twoFaToken: S.twoFaToken }) });
    } catch (e) { throw new Error("Pas de connexion internet."); }
    if (r.status === 401) throw new Error("Clé d'accès refusée : rouvrez le lien d'installation.");
    if (!r.ok) throw new Error(`Relais indisponible (${r.status}).`);
    const j = await r.json();
    S.cookies = { ...(S.cookies || {}), ...(j.cookies || {}) };
    if (j.xToken) S.token = j.xToken;
    if (j.json?.token) S.token = j.json.token;
    return j.json || {};
  }

  async function login() {
    const c = creds();
    if (!c) throw new NeedLogin();
    S = { cn: S.cn, cv: S.cv, cookies: {} };
    await relay("login.awp?gtk=1", null, true);
    const r = await relay("login.awp", { identifiant: c.u, motdepasse: c.p, isReLogin: false, uuid: "",
      fa: S.cn && S.cv ? [{ cn: S.cn, cv: S.cv }] : [] });
    if (r.code === 250) {
      S.twoFaToken = S.token;
      const q = await relay("connexion/doubleauth.awp?verbe=get", {});
      if (q.code !== 200) throw new Error(q.message || "Question de sécurité indisponible.");
      saveS();
      return { status: "2fa", question: unb64(q.data.question), choices: q.data.propositions.map(unb64) };
    }
    if (r.code !== 200) throw new Error(r.code === 505 ? "Identifiant ou mot de passe incorrect." : r.message || `Connexion refusée (${r.code}).`);
    S.twoFaToken = undefined;
    const acc = r.data.accounts[0], eleves = acc.profile?.eleves ?? [];
    const el = acc.typeCompte === "E" || !eleves.length ? acc : eleves[0];
    S.accountId = el.id; S.accountName = `${el.prenom} ${el.nom}`;
    S.classe = (acc.typeCompte === "E" ? acc.profile?.classe?.libelle : el.classe?.libelle) || "";
    saveS();
    return { status: "ok" };
  }

  async function answer2fa(choice) {
    const a = await relay("connexion/doubleauth.awp?verbe=post", { choix: b64(choice) });
    if (a.code !== 200) throw new Error(a.message || "Mauvaise réponse, réessayez.");
    S.cn = a.data.cn; S.cv = a.data.cv; S.twoFaToken = undefined; saveS();
    return login();
  }

  async function call(path, data = {}) {
    if (!S.token || !S.accountId) { const l = await login(); if (l.status !== "ok") throw new NeedLogin(); }
    let r = await relay(path, data);
    if (r.code === 520 || r.code === 525) { // jeton expiré : reconnexion une fois
      const l = await login(); if (l.status !== "ok") throw new NeedLogin();
      r = await relay(path, data);
    }
    if (r.code !== 200) throw new Error(r.message || `Erreur Ecole Directe (${r.code}).`);
    return r.data;
  }

  // ── Synchro (même résultat que scripts/sync.mjs) ──
  async function sync() {
    const today = new Date(), from = isoD(today), to = isoD(new Date(today.getTime() + DAYS * 864e5));
    const d = await call(`eleves/${S.accountId}/notes.awp?verbe=get`, { anneeScolaire: "" });
    const agenda = await call(`Eleves/${S.accountId}/cahierdetexte.awp?verbe=get`, {});
    const dates = Object.keys(agenda ?? {}).filter((x) => x >= from && x <= to).sort();
    const days = [];
    for (let i = 0; i < dates.length; i += 4) // 4 jours à la fois
      days.push(...await Promise.all(dates.slice(i, i + 4).map((dt) => call(`Eleves/${S.accountId}/cahierdetexte/${dt}.awp?verbe=get`, {}).then((x) => [dt, x]))));
    const hw = [];
    for (const [date, day] of days) for (const m of day.matieres ?? []) {
      const a = m.aFaire; if (!a) continue;
      hw.push({ pourLe: date, matiere: m.matiere, donneLe: a.donneLe, effectue: a.effectue, interrogation: m.interrogation, contenu: a.contenu ? htmlToText(unb64(a.contenu)) : "" });
    }
    const periodes = (d.periodes ?? []).map((p) => ({ id: p.idPeriode, nom: p.periode, cloture: p.cloture,
      moyenneGenerale: p.ensembleMatieres?.moyenneGeneral, moyenneClasse: p.ensembleMatieres?.moyenneClasse,
      matieres: (p.ensembleMatieres?.disciplines ?? []).map((m) => ({ matiere: m.discipline, moyenneEleve: m.moyenne, moyenneClasse: m.moyenneClasse, coefficient: m.coef })) }));
    const notes = (d.notes ?? [])
      .map((n) => ({ date: n.date, matiere: n.libelleMatiere, devoir: n.devoir, note: num(n.valeur), sur: num(n.noteSur) ?? 20, coefficient: num(n.coef) ?? 1, moyenneClasse: num(n.moyenneClasse), periode: n.codePeriode, nonSignificatif: n.nonSignificatif }))
      .filter((n) => n.note != null && !n.nonSignificatif).sort((a, b) => a.date.localeCompare(b.date));
    const trim = [...periodes].filter((p) => /^A00\d$/.test(p.id) && p.matieres.some((m) => num(m.moyenneEleve) != null)).pop();
    const officiel = {};
    for (const m of trim?.matieres ?? []) if (num(m.moyenneEleve) != null && !/^pôle/i.test(m.matiere)) officiel[m.matiere] = { eleve: num(m.moyenneEleve), classe: num(m.moyenneClasse) };
    const devoirs = hw.map((x) => ({ date: x.pourLe, matiere: x.matiere, titre: x.contenu, source: "ecoledirecte", controle: !!x.interrogation, rendu: !!x.effectue }));
    LS.set("vs-data", { eleve: S.accountName, classe: S.classe || "", generatedAt: from, sources: { ecoledirecte: { ok: true } },
      officielPeriode: { A001: "T1", A002: "T2", A003: "T3" }[trim?.id], officiel, notes, devoirs, periodesED: periodes, layout: LS.get("vs-layout") || undefined });
    LS.set("vs-summary", summary(S.accountName, from, trim, notes, officiel, hw));
    LS.set("vs-synced-at", Date.now());
    return { notes: notes.length, devoirs: hw.length };
  }

  function summary(eleve, today, trim, notes, officiel, hw) {
    const by = new Map();
    for (const n of notes) (by.get(n.matiere) ?? by.set(n.matiere, []).get(n.matiere)).push(n);
    const rows = [...by].map(([m, a]) => {
      const o = officiel[m]; let s = 0, c = 0, sc = 0, cc = 0;
      for (const n of a) { s += (n.note / n.sur) * 20 * n.coefficient; c += n.coefficient; if (n.moyenneClasse != null) { sc += (n.moyenneClasse / n.sur) * 20 * n.coefficient; cc += n.coefficient; } }
      const avg = o?.eleve ?? s / c, cls = o?.classe ?? (cc ? sc / cc : null);
      const last = a.slice(-3).reduce((t, n) => t + (n.note / n.sur) * 20, 0) / Math.min(3, a.length);
      return { m, avg, cls, n: a.length, trend: a.length < 3 ? "peu de notes" : last > avg + 1 ? "↗" : last < avg - 1 ? "↘" : "→" };
    }).sort((x, y) => x.avg - y.avg);
    const gen = rows.length ? rows.reduce((t, r) => t + r.avg, 0) / rows.length : null;
    const byDay = new Map();
    for (const x of hw) (byDay.get(x.pourLe) ?? byDay.set(x.pourLe, []).get(x.pourLe)).push(x);
    return [`# ${eleve} — synthèse du ${fr(today)}`, `Moyenne générale (moyenne des matières, ${trim?.nom ?? "période en cours"}) : ${f1(gen)}/20 · ${notes.length} notes`, ``,
      `## Matières (de la plus faible à la plus forte)`, ...rows.map((r) => `- ${r.m} : ${f1(r.avg)}${r.cls != null ? ` (classe ${f1(r.cls)})` : ""} · ${r.n} notes · ${r.trend}`), ``,
      `## Devoirs des ${DAYS} prochains jours`, ...[...byDay].flatMap(([d, a]) => [`${fr(d)}`, ...a.map((x) => `- ${x.interrogation ? "⚠ CONTRÔLE " : ""}${x.matiere}${x.effectue ? " ✔" : ""} : ${x.contenu.slice(0, 220)}`)]),
      hw.length ? "" : "Aucun devoir."].join("\n");
  }

  // ── Fenêtre de connexion ──
  let dlg;
  const el = (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstChild; };
  function openLogin(msg) {
    return new Promise((resolve) => {
      dlg?.remove();
      dlg = el(`<dialog class="synth vs-login" aria-labelledby="vs-t"><h2 id="vs-t">Connexion Ecole Directe</h2><div id="vs-body"></div></dialog>`);
      document.body.append(dlg);
      const body = dlg.querySelector("#vs-body");
      const err = (m) => { const e = body.querySelector(".vs-err"); e.textContent = m || ""; e.hidden = !m; };
      const step1 = () => {
        const c = creds() || {};
        body.innerHTML = `<form class="vs-form">${msg ? `<p class="t-meta">${msg}</p>` : ""}
          <label>Identifiant<input name="u" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
          <label>Mot de passe<input name="p" type="password" autocomplete="current-password" required></label>
          <label class="vs-check"><input name="r" type="checkbox" checked> Rester connecté sur ce téléphone</label>
          <p class="vs-err" role="alert" hidden></p>
          <button class="act primary" type="submit">Se connecter</button>
          <p class="t-meta">Vos identifiants restent sur ce téléphone. Ils passent par votre relais privé le temps de l'appel, sans y être enregistrés.</p></form>`;
        const f = body.querySelector("form");
        f.u.value = c.u || "";
        f.addEventListener("submit", async (e) => {
          e.preventDefault(); err("");
          const btn = f.querySelector("button"); btn.disabled = true; btn.textContent = "Connexion…";
          memCreds = { u: f.u.value.trim(), p: f.p.value };
          LS.set("vs-creds", f.r.checked ? memCreds : null);
          try { const r = await login(); r.status === "ok" ? done() : step2(r); }
          catch (x) { err(x instanceof NeedLogin ? "Identifiants manquants." : x.message); btn.disabled = false; btn.textContent = "Se connecter"; }
        });
      };
      const step2 = (q) => {
        body.innerHTML = `<p>Ecole Directe pose une question de sécurité (une seule fois sur ce téléphone).</p><p><b></b></p><div class="vs-choices"></div><p class="vs-err" role="alert" hidden></p>`;
        body.querySelector("b").textContent = q.question;
        const box = body.querySelector(".vs-choices");
        for (const ch of q.choices) {
          const b = el(`<button class="act" type="button"></button>`); b.textContent = ch; box.append(b);
          b.addEventListener("click", async () => {
            box.querySelectorAll("button").forEach((x) => (x.disabled = true)); err("");
            try { const r = await answer2fa(ch); r.status === "ok" ? done() : step2(r); }
            catch (x) { err(x.message); box.querySelectorAll("button").forEach((y) => (y.disabled = false)); }
          });
        }
      };
      const done = async () => {
        body.innerHTML = `<p role="status">Connecté. Récupération des notes et des devoirs…</p>`;
        try { await sync(); dlg.close(); resolve(true); }
        catch (x) { body.innerHTML = `<p class="vs-err" role="alert"></p><button class="act primary" type="button">Réessayer</button>`; body.querySelector(".vs-err").textContent = x.message; body.querySelector("button").onclick = done; }
      };
      dlg.addEventListener("cancel", (e) => { if (!LS.get("vs-data")) e.preventDefault(); else resolve(false); });
      step1(); dlg.showModal();
    });
  }

  async function runSync() {
    try { await sync(); return { ok: true }; }
    catch (x) {
      if (!(x instanceof NeedLogin)) return { ok: false, error: x.message };
      return (await openLogin("La session a expiré, reconnectez-vous.")) ? { ok: true } : { ok: false, error: "Connexion annulée." };
    }
  }

  // ── Les routes /api/* du dashboard, traitées sur le téléphone ──
  window.fetch = (input, init) => {
    const u = typeof input === "string" ? input : input?.url ?? "";
    if (!u.startsWith("/api/") || u.startsWith("/api/ed")) return origFetch(input, init);
    const reply = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
    if (u === "/api/ping") return Promise.resolve(reply({ ok: true }));
    if (u === "/api/resume") return Promise.resolve(reply({ text: LS.get("vs-summary") || "" }));
    if (u === "/api/layout") { try { LS.set("vs-layout", JSON.parse(init?.body || "[]")); } catch (e) {} return Promise.resolve(reply({ ok: true })); }
    if (u === "/api/sync") return runSync().then(reply);
    return Promise.resolve(reply({ error: "introuvable" }));
  };

  // ── Bouton Compte (remplace « Mobile ») et premier lancement ──
  function account() {
    const d = el(`<dialog class="synth" aria-labelledby="vs-a"><h2 id="vs-a">Compte</h2><div></div></dialog>`);
    const at = LS.get("vs-synced-at");
    d.querySelector("div").innerHTML = `<p></p><p class="t-meta">${at ? "Dernière mise à jour : " + new Date(at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : ""}</p>
      <p class="t-meta">${LS.get("vs-creds") ? "Identifiants mémorisés sur ce téléphone." : "Identifiants non mémorisés : il faudra les ressaisir quand la session expire."}</p>
      <div class="vs-choices"><button class="act" type="button" data-a="out">Se déconnecter et effacer les données</button><button class="act primary" type="button" data-a="close">Fermer</button></div>`;
    d.querySelector("p").textContent = S.accountName ? `Connecté : ${S.accountName}` : "Non connecté";
    d.addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (a === "close") d.close();
      if (a === "out" && confirm("Effacer la session, les identifiants et les notes de ce téléphone ?")) {
        ["vs-session", "vs-creds", "vs-data", "vs-summary", "vs-synced-at", "vs-layout"].forEach((k) => LS.set(k, null));
        location.reload();
      }
    });
    d.addEventListener("close", () => d.remove());
    document.body.append(d); d.showModal();
  }

  document.addEventListener("DOMContentLoaded", () => {
    const m = document.getElementById("act-mobile");
    if (m) {
      const b = m.cloneNode(true); // retire le comportement « QR code du PC »
      b.querySelector("span").textContent = "Compte";
      b.querySelector("svg").innerHTML = '<circle cx="10" cy="7" r="3.5"/><path d="M3.5 17a6.5 6.5 0 0 1 13 0"/>';
      b.addEventListener("click", account);
      m.replaceWith(b);
    }
    if (!LS.get("vs-key")) {
      const t = document.getElementById("toast");
      if (t) { t.textContent = "Ouvrez une fois le lien d'installation complet (avec la clé ?k=…)."; t.hidden = false; }
      return;
    }
    if (!LS.get("vs-data")) { openLogin().then((ok) => ok && location.reload()); return; }
    // Mise à jour automatique à l'ouverture si les données ont plus de 3 h et que les identifiants sont mémorisés
    if (LS.get("vs-creds") && Date.now() - (LS.get("vs-synced-at") || 0) > STALE_MS && navigator.onLine) {
      const t = document.getElementById("toast");
      if (t) { t.textContent = "Mise à jour des notes…"; t.hidden = false; }
      sync().then(() => location.reload(), () => { if (t) { t.textContent = "Mise à jour impossible : touchez Actualiser."; setTimeout(() => (t.hidden = true), 6000); } });
    }
  });

  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
})();
