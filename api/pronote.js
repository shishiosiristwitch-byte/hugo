// Relais PRONOTE pour l'app mobile (fonction Vercel).
// Le navigateur ne peut pas parler à PRONOTE (CORS, chiffrement maison) : cette fonction se connecte
// avec Pawnote, récupère notes, devoirs, emploi du temps et vie scolaire de chaque enfant du compte, normalisés.
// Elle ne stocke RIEN et ne journalise rien : identifiants et jeton restent sur le téléphone,
// ils ne font que transiter le temps de l'appel.
import crypto from "node:crypto";
import { fetchPronote, explain, parseUrl } from "./_lib/pronote.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const str = (v, max = 512) => (typeof v === "string" && v.length && v.length <= max ? v : undefined);
// Seuls les serveurs PRONOTE hébergés par Index Éducation sont acceptés (+ PRONOTE_HOSTS, séparés par des virgules)
const hostOk = (h) => /(^|\.)index-education\.net$/i.test(h)
  || (process.env.PRONOTE_HOSTS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).includes(h.toLowerCase());

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST uniquement" });
  const key = process.env.VS_KEY?.trim();
  if (!key || !same(req.headers["x-vs-key"] ?? "", key)) return res.status(401).json({ error: "clé invalide" });

  let b;
  try { b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {}; } catch { return res.status(400).json({ error: "JSON invalide" }); }
  const url = str(b.url, 300), username = str(b.username, 200), password = str(b.password, 200), token = str(b.token, 1024), tokenUsername = str(b.tokenUsername, 200);
  const connexion = b.connexion === "ent" ? "ent" : undefined; // ÉduConnect par défaut si l'établissement passe par un ENT
  const deviceUUID = /^[\w-]{8,80}$/.test(b.deviceUUID ?? "") ? b.deviceUUID : undefined;
  if (!url || !username || !deviceUUID || (!password && !token)) return res.status(400).json({ error: "Paramètres manquants." });
  try { if (!hostOk(new URL(parseUrl(url).url).hostname)) return res.status(400).json({ error: "Adresse PRONOTE non autorisée : elle doit se terminer par index-education.net." }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  // Compte parent : "all" = tous les enfants du compte (une seule connexion), ou une liste d'index
  const children = b.children === "all" ? "all" : Array.isArray(b.children) ? b.children.filter((i) => Number.isInteger(i) && i >= 0 && i < 20).slice(0, 10) : undefined;
  const childIndex = Number.isInteger(b.childIndex) && b.childIndex >= 0 && b.childIndex < 20 ? b.childIndex : undefined;
  const days = Number.isInteger(b.days) && b.days > 0 && b.days <= 60 ? b.days : 21;

  try {
    const r = await fetchPronote({ url, username, password, token, tokenUsername, connexion, deviceUUID, children, childIndex, days });
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    const auth = ["BadCredentialsError", "SecurityError", "AccountDisabledError", "AccessDeniedError"].includes(e?.name);
    return res.status(200).json({ ok: false, auth, error: explain(e) });
  }
}
