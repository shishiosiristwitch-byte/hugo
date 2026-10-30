// Connexion PRONOTE via un ENT Edifice (ENT Hauts-de-France : enthdf.fr, et autres ENT « Open ENT NG »).
// 1. Connexion à l'ENT : compte ENT local (POST /auth/login) ou, pour les parents et élèves, ÉduConnect (SAML)
// 2. Ouverture de la page PRONOTE : redirection vers le CAS de l'ENT, qui renvoie un ticket à PRONOTE
// 3. La page PRONOTE contient alors les identifiants « e » / « f » à utiliser pour se connecter (mode ENT)
// Rien n'est stocké ici : les cookies ne vivent que le temps de l'appel.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

class Jar {
  c = new Map(); // hôte -> Map(nom -> valeur)
  store(url, res) {
    const h = new URL(url).hostname.toLowerCase();
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const kv = sc.split(";")[0], i = kv.indexOf("=");
      if (i <= 0) continue;
      const dom = (/;\s*domain=\.?([^;]+)/i.exec(sc)?.[1] ?? h).toLowerCase();
      if (!this.c.has(dom)) this.c.set(dom, new Map());
      this.c.get(dom).set(kv.slice(0, i).trim(), kv.slice(i + 1));
    }
  }
  header(url) {
    const h = new URL(url).hostname.toLowerCase(), out = [];
    for (const [dom, m] of this.c) if (h === dom || h.endsWith("." + dom)) for (const [k, v] of m) out.push(`${k}=${v}`);
    return out.join("; ");
  }
  get(url, name) {
    const h = new URL(url).hostname.toLowerCase();
    for (const [dom, m] of this.c) if ((h === dom || h.endsWith("." + dom)) && m.has(name)) return m.get(name);
    return undefined;
  }
  list(url) { return this.header(url).split("; ").filter(Boolean); }
}

// Formulaires HTML : action + champs (pour suivre les étapes SAML et remplir ÉduConnect)
const decode = (v) => v.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x3a;/gi, ":").replace(/&#x2f;/gi, "/").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
function forms(html, base) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(([, attrs, inner]) => {
    const at = (n, src) => decode(new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, "i").exec(src)?.[1] ?? "");
    const fields = {};
    for (const [inp] of inner.matchAll(/<(input|button)\b[^>]*>/gi)) { const n = at("name", inp); if (n) fields[n] = at("value", inp); }
    return { action: new URL(at("action", attrs) || base, base).href, method: (at("method", attrs) || "get").toLowerCase(), fields };
  });
}
export const _forms = forms;

async function go(jar, url, opts = {}, max = 12) {
  for (let i = 0; i < max; i++) {
    const res = await fetch(url, { ...opts, redirect: "manual", headers: { "User-Agent": UA, ...(jar.header(url) ? { Cookie: jar.header(url) } : {}), ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
    jar.store(url, res);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).href; opts = {}; continue; }
    return { res, url, text: await res.text() };
  }
  throw new Error("Trop de redirections pendant la connexion ENT.");
}

// Suit redirections ET formulaires SAML auto-soumis (SAMLRequest / SAMLResponse) jusqu'à une vraie page
async function walk(jar, url, opts = {}) {
  let p = await go(jar, url, opts);
  for (let i = 0; i < 6; i++) {
    // + étape Shibboleth « chargement des informations de session » (stockage du navigateur : on répond « non supporté »)
    const f = forms(p.text, p.url).find((x) => "SAMLRequest" in x.fields || "SAMLResponse" in x.fields || "shib_idp_ls_supported" in x.fields);
    if (!f) return p;
    if ("shib_idp_ls_supported" in f.fields) for (const k of Object.keys(f.fields)) if (/^shib_idp_ls_(success|exception)/.test(k)) f.fields[k] = k.includes("success") ? "false" : "";
    p = await go(jar, f.action, { method: "POST", body: new URLSearchParams(f.fields), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  }
  return p;
}
export const _walk = walk, _Jar = Jar;

/** Adresse de l'ENT vers laquelle PRONOTE redirige (null si connexion PRONOTE directe). */
export async function detectEnt(pageUrl) {
  const res = await fetch(pageUrl, { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && loc && /\/cas\/login/i.test(loc)) return new URL(loc, pageUrl).origin;
  return null;
}

const title = (html) => /<title>([^<]*)/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
const fail = (name, msg) => Object.assign(new Error(msg), { name });

/** Compte ENT local (identifiant Edifice) */
async function entLocal(jar, entOrigin, username, password) {
  await go(jar, `${entOrigin}/auth/login`);
  const xsrf = jar.get(entOrigin, "XSRF-TOKEN");
  const r = await go(jar, `${entOrigin}/auth/login`, { method: "POST", body: new URLSearchParams({ email: username, password }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(xsrf ? { "X-XSRF-TOKEN": decodeURIComponent(xsrf) } : {}) } }, 1).catch(() => null);
  if (!jar.get(entOrigin, "oneSessionId")) throw fail("BadCredentialsError", "Identifiant ou mot de passe ENT incorrect.");
  return r;
}

/** Compte ÉduConnect (parents et élèves) : ENT → ÉduConnect (SAML) → ENT */
async function entEduconnect(jar, entOrigin, profil, callBack, username, password) {
  let p = await walk(jar, `${entOrigin}/auth/saml/authn/${profil}?callBack=${encodeURIComponent(callBack)}`);
  const login = forms(p.text, p.url).find((f) => "j_username" in f.fields);
  if (!login) throw new Error(`Page de connexion ÉduConnect introuvable (« ${title(p.text)} »).`);
  login.fields.j_username = username; login.fields.j_password = password;
  for (const k of Object.keys(login.fields)) if (k.startsWith("_eventId_") && k !== "_eventId_proceed") delete login.fields[k];
  p = await walk(jar, login.action, { method: "POST", body: new URLSearchParams(login.fields), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (process.env.ENT_DEBUG) console.log("[ENT] après ÉduConnect :", p.url.split("?")[0], p.res.status, "«", title(p.text), "» cookies ENT :", jar.list(entOrigin).map((c) => c.split("=")[0]).join(","));
  if (/educonnect\.education\.gouv\.fr/.test(p.url)) {
    if (forms(p.text, p.url).some((f) => "j_username" in f.fields)) {
      // Message réellement affiché par ÉduConnect (les blocs d'erreur masqués portent la classe fr-hidden)
      const msg = [...p.text.matchAll(/<div[^>]*class="([^"]*fr-messages-group[^"]*)"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/gi)]
        .filter((m) => !/fr-hidden/.test(m[1])).map((m) => decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()).filter(Boolean)[0]
        ?? [...p.text.matchAll(/<div[^>]*class="[^"]*fr-alert[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)].map((m) => decode(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()).filter(Boolean)[0];
      if (process.env.ENT_DEBUG) console.log("[ENT] étape ÉduConnect :", /execution=([\w]+)/.exec(p.url)?.[1] ?? forms(p.text, p.url).map((f) => /execution=([\w]+)/.exec(f.action)?.[1]).join(","), "captcha :", /captcha/i.test(p.text.replace(/captchetat-js\.js/g, "")));
      throw fail("BadCredentialsError", `ÉduConnect a refusé la connexion${msg ? ` : « ${msg.slice(0, 200)} »` : " (identifiant ou mot de passe incorrect, ou compte bloqué après plusieurs essais)"}.`);
    }
    throw fail("SecurityError", `ÉduConnect demande une action (« ${title(p.text)} ») : connectez-vous une fois sur l'ENT dans un navigateur pour la valider, puis réessayez.`);
  }
  return p;
}

/**
 * Se connecte à l'ENT (ÉduConnect par défaut, ou compte ENT local) puis ouvre pageUrl (page PRONOTE mobile) :
 * renvoie les cookies PRONOTE et les identifiants « e » / « f » de la session ENT.
 * @param {"educonnect"|"ent"} mode   @param {"relative"|"student"} profil
 * @returns {{ cookies: string[], e: string, f: string }}
 */
export async function loginEnt(entOrigin, pageUrl, username, password, { mode = "educonnect", profil = "relative" } = {}) {
  const jar = new Jar();
  const cas = (await fetch(pageUrl, { redirect: "manual", headers: { "User-Agent": UA } })).headers.get("location") || `${entOrigin}/cas/login?service=${encodeURIComponent(pageUrl)}`;
  if (mode === "ent") await entLocal(jar, entOrigin, username, password);
  else await entEduconnect(jar, entOrigin, profil, cas, username, password);
  const page = await go(jar, pageUrl);
  if (process.env.ENT_DEBUG) console.log("[ENT] page PRONOTE :", page.url.split("?")[0], page.res.status, "Start :", (/Start\s*\(\s*\{[^)]*/.exec(page.text)?.[0] ?? "absent").replace(/"(e|f)"\s*:\s*"[^"]+"/g, '"$1":"…"').slice(0, 160));
  if (/\/auth\/(saml\/wayf|login)/.test(page.url)) throw fail("BadCredentialsError", "L'ENT n'a pas ouvert de session : identifiants ENT refusés.");
  const raw = /Start\s*\(\s*(\{[\s\S]*?\})\s*\)/.exec(page.text)?.[1] ?? "";
  const e = /["']?e["']?\s*:\s*["']([^"']+)["']/.exec(raw)?.[1], f = /["']?f["']?\s*:\s*["']([^"']+)["']/.exec(raw)?.[1];
  if (!e || !f) throw new Error(`PRONOTE n'a pas reconnu la session ENT (page « ${title(page.text)} »).`);
  return { cookies: jar.list(page.url), e, f };
}
