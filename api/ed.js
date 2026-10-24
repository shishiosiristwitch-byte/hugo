// Relais Ecole Directe pour l'app mobile (fonction Vercel).
// Un navigateur ne peut pas appeler l'API Ecole Directe lui-même (cookie GTK, User-Agent, CORS) :
// ce relais transmet la requête telle quelle et renvoie la réponse. Il ne stocke RIEN et ne journalise rien :
// identifiants, jetons et cookies restent sur le téléphone et transitent seulement le temps de l'appel.
import crypto from "node:crypto";

const BASE = "https://api.ecoledirecte.com/v3";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Seuls les appels utilisés par l'app passent : le relais n'est pas un proxy ouvert.
const ALLOWED = [
  /^login\.awp\?gtk=1$/,
  /^login\.awp$/,
  /^connexion\/doubleauth\.awp\?verbe=(get|post)$/,
  /^eleves\/\d{1,10}\/notes\.awp\?verbe=get$/,
  /^Eleves\/\d{1,10}\/cahierdetexte\.awp\?verbe=get$/,
  /^Eleves\/\d{1,10}\/cahierdetexte\/\d{4}-\d{2}-\d{2}\.awp\?verbe=get$/,
];

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const str = (v, max = 4096) => (typeof v === "string" && v.length <= max ? v : undefined);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST uniquement" });
  const key = process.env.VS_KEY?.trim();
  if (!key || !same(req.headers["x-vs-key"] ?? "", key)) return res.status(401).json({ error: "clé invalide" });

  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
  const p = str(b.path, 200);
  if (!p || !ALLOWED.some((r) => r.test(p))) return res.status(400).json({ error: "appel non autorisé" });
  const v = /^\d{1,2}\.\d{1,3}\.\d{1,3}$/.test(b.v ?? "") ? b.v : "4.75.0";
  const url = `${BASE}/${p}${p.includes("?") ? "&" : "?"}v=${v}`;
  const isGtk = p === "login.awp?gtk=1";

  const headers = { "User-Agent": UA };
  const cookies = b.cookies && typeof b.cookies === "object" ? b.cookies : {};
  const jar = Object.entries(cookies).filter(([k, val]) => /^[\w.-]{1,64}$/.test(k) && str(val)).slice(0, 20);
  if (jar.length) headers.Cookie = jar.map(([k, val]) => `${k}=${val}`).join("; ");
  if (!isGtk) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (str(b.token)) headers["X-Token"] = b.token;
    if (str(b.twoFaToken)) headers["2FA-Token"] = b.twoFaToken;
    if (cookies.GTK && str(cookies.GTK)) headers["X-Gtk"] = cookies.GTK;
  }

  let r;
  try {
    r = await fetch(url, {
      method: isGtk ? "GET" : "POST",
      headers,
      body: isGtk ? undefined : "data=" + encodeURIComponent(JSON.stringify(b.data ?? {})),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return res.status(502).json({ error: "Ecole Directe injoignable" });
  }

  const outCookies = {};
  for (const c of r.headers.getSetCookie?.() ?? []) {
    const kv = c.split(";")[0], i = kv.indexOf("=");
    if (i > 0) outCookies[kv.slice(0, i).trim()] = kv.slice(i + 1);
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* réponse vide (GTK) ou non JSON */ }
  return res.status(200).json({ status: r.status, json, cookies: outCookies, xToken: r.headers.get("x-token") });
}
