// Connecteur PRONOTE commun au PC (scripts/sync.mjs) et à l'app mobile (mobile/api/pronote.js).
// Basé sur Pawnote (API non officielle) + scripts/patch-pawnote.mjs pour PRONOTE 2026.2.
// Renvoie les données au format du dashboard (même forme que la synchro Ecole Directe),
// plus deux blocs propres à PRONOTE : emploi du temps (edt) et vie scolaire.
import * as P from "pawnote";
import { defaultFetcher } from "@literate.ink/utilities";
import { detectEnt, loginEnt } from "./ent.mjs";

const TZ = "Europe/Paris";
const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  .formatToParts(d).map((p) => [p.type, p.value]));
/** Date → "AAAA-MM-JJ" (heure de Paris) */
export const day = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
/** Date → "AAAA-MM-JJTHH:MM" (heure de Paris) */
export const dayTime = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", ecirc: "ê", ocirc: "ô", ucirc: "û", icirc: "î" };
export const htmlToText = (h = "") => String(h)
  .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m)
  .replace(/\s+/g, " ").trim();
const cap = (s = "") => s.charAt(0) + s.slice(1).toLowerCase(); // "MATHÉMATIQUES" → "Mathématiques"
// "MATHÉMATIQUES > Écrit" → "Mathématiques > Écrit", "ANGLAIS LV1" → "Anglais LV1"
const subj = (s) => (s?.name ? s.name.split(" > ").map((x) => (x === x.toUpperCase() ? cap(x) : x)).join(" > ").replace(/\blv(\d)/gi, "LV$1") : "Autre");
const val = (g) => (g && g.kind === P.GradeKind.Grade && Number.isFinite(g.points) ? g.points : null);

/** Messages d'erreur lisibles pour l'utilisateur. */
export function explain(e) {
  const n = e?.name || "";
  if (n === "BadCredentialsError") return /ENT|ÉduConnect/.test(e?.message ?? "") ? e.message : "Identifiant ou mot de passe PRONOTE incorrect.";
  if (n === "SecurityError" && e?.message?.includes("ENT")) return e.message;
  if (n === "SecurityError") return "PRONOTE demande une vérification de sécurité (code PIN ou appareil à enregistrer) : connectez-vous une fois sur le site PRONOTE de l'établissement, puis réessayez.";
  if (n === "AccountDisabledError") return "Ce compte PRONOTE est désactivé.";
  if (n === "AccessDeniedError") return "Ce compte n'a pas accès à cet espace PRONOTE (élève / parent).";
  if (n === "SuspendedIPError" || n === "RateLimitedError") return "PRONOTE a temporairement bloqué les connexions : réessayez dans quelques minutes.";
  if (n === "PageUnavailableError" || n === "BusyPageError") return "Le site PRONOTE de l'établissement est indisponible ou l'adresse est incorrecte.";
  if (n === "SessionExpiredError") return "La session PRONOTE a expiré.";
  if (n === "TypeError" && /fetch failed/i.test(e?.message || "")) return "Site PRONOTE injoignable : vérifiez l'adresse (et la connexion internet).";
  return e?.message || "Erreur PRONOTE inconnue.";
}

/** Adresse PRONOTE saisie (avec ou sans eleve.html) → espace et URL propre. */
export function parseUrl(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch { throw Object.assign(new Error("Adresse PRONOTE invalide."), { name: "UrlError" }); }
  if (u.protocol !== "https:") throw Object.assign(new Error("L'adresse PRONOTE doit commencer par https://"), { name: "UrlError" });
  const page = u.pathname.split("/").pop() || "";
  const kind = /parent/i.test(page) ? P.AccountKind.PARENT : P.AccountKind.STUDENT;
  return { url: P.cleanURL(u.href), kind };
}

/**
 * Connexion : jeton mémorisé d'abord (sans ENT), sinon identifiant + mot de passe :
 * directement sur PRONOTE, ou via l'ENT (CAS) si PRONOTE redirige vers un ENT (ex. ENT Hauts-de-France).
 */
async function connect({ url, username, password, token, tokenUsername, deviceUUID, kind, connexion }) {
  const target = parseUrl(url);
  const k = kind ?? target.kind;
  const base = { url: target.url, kind: k, deviceUUID };
  let lastErr;
  if (token) {
    try { const s = P.createSessionHandle(); return { s, refresh: await P.loginToken(s, { ...base, username: tokenUsername || username, token }) }; }
    catch (e) { lastErr = e; if (!password) throw e; }
  }
  if (!password) throw lastErr ?? Object.assign(new Error("Mot de passe PRONOTE manquant."), { name: "BadCredentialsError" });
  // Sans le paramètre « bydlg » (connexion directe), un établissement relié à un ENT redirige vers le CAS de l'ENT
  const page = `${target.url}/mobile.${k === P.AccountKind.PARENT ? "parent" : "eleve"}.html?fd=1&login=true`;
  const ent = await detectEnt(page).catch(() => null);
  if (!ent) { const s = P.createSessionHandle(); return { s, refresh: await P.loginCredentials(s, { ...base, username, password }) }; }
  // Via l'ENT : PRONOTE fournit, dans sa page de démarrage, des identifiants « e » / « f » valables pour la session ENT.
  // Ils changent à chaque chargement : on garde ceux de la dernière page reçue.
  // « connexion » : "educonnect" (défaut, parents et élèves) ou "ent" (compte ENT local)
  const { cookies, e, f } = await loginEnt(ent, page, username, password, { mode: connexion === "ent" ? "ent" : "educonnect", profil: k === P.AccountKind.PARENT ? "relative" : "student" });
  const cur = { e, f };
  const fetcher = async (req) => {
    const r = await defaultFetcher(req);
    const m = /Start\s*\(\s*(\{[\s\S]*?\})\s*\)/.exec(r.content || "")?.[1];
    if (m) { const e2 = /["']?e["']?\s*:\s*["']([^"']+)["']/.exec(m)?.[1], f2 = /["']?f["']?\s*:\s*["']([^"']+)["']/.exec(m)?.[1]; if (e2 && f2) Object.assign(cur, { e: e2, f: f2 }); }
    if (process.env.ENT_DEBUG) {
      if (m) console.log("[PN] page", String(req.url).split("?")[0].split("/").pop(), "Start", m.replace(/"(e|f)"\s*:\s*"[^"]+"/g, '"$1":"…"').slice(0, 120));
      else { let j = null; try { j = JSON.parse(r.content); } catch {} const d = j?.dataSec?.data ?? j?.donneesSec?.donnees;
        console.log("[PN]", j?.id ?? j?.nom ?? "?", r.status, d ? JSON.stringify(d).replace(/"(alea|challenge|cle|identifiantNav)":"[^"]+"/g, '"$1":"…"').slice(0, 260) : String(r.content).slice(0, 160)); }
    }
    return r;
  };
  const s = P.createSessionHandle(fetcher);
  const auth = { ...base, cookies, params: { fd: "1", login: "true" } };
  Object.defineProperty(auth, "username", { get: () => cur.e, set() {}, enumerable: true });
  Object.defineProperty(auth, "password", { get: () => cur.f, set() {}, enumerable: true });
  const refresh = await P.loginENT(s, auth);
  return { s, refresh };
}

/** "PARENT Fanny" → "Fanny" (PRONOTE écrit le nom de famille en majuscules) */
export const prenomDe = (nom = "") => {
  const w = nom.trim().split(/\s+/), low = w.filter((x) => x !== x.toUpperCase());
  return low.length ? low.join(" ") : cap(w.at(-1) || "Élève");
};

/**
 * Récupère et normalise les données PRONOTE, avec UNE connexion pour tous les enfants du compte.
 * @param {object} o url, username, password?, token?, deviceUUID, days (21 par défaut),
 *   children : "all" (tous les enfants du compte parent), [index…], ou absent (premier / childIndex)
 * @returns {{ eleves: { index, nom, prenom, classe, data }[], data, enfants, refresh }}
 */
export async function fetchPronote(o) {
  const days = o.days ?? 21;
  const { s, refresh } = await connect(o);
  const all = s.user.resources.map((_, i) => i);
  const idx = o.children === "all" ? all : Array.isArray(o.children) ? o.children.filter((i) => all.includes(i)) : [all.includes(o.childIndex) ? o.childIndex : 0];
  const eleves = [];
  for (const i of idx) {
    P.use(s, i);
    const data = await collect(s, days);
    eleves.push({ index: i, nom: data.eleve, prenom: prenomDe(data.eleve), classe: data.classe, data });
  }
  const enfants = s.user.resources.map((r, i) => ({ index: i, nom: r.name, prenom: prenomDe(r.name), classe: r.className || "" }));
  return { eleves, data: eleves[0]?.data, enfants: enfants.length > 1 ? enfants : undefined,
    refresh: { url: refresh.url, username: refresh.username, token: refresh.token, kind: refresh.kind } };
}

/** Données d'un élève (l'enfant sélectionné dans la session). */
async function collect(s, days) {
  const res = s.userResource, tabs = res.tabs;
  const now = new Date(), end = new Date(now.getTime() + days * 864e5);
  const warnings = [];
  const safe = async (label, f, fallback) => { try { return await f(); } catch (e) { warnings.push(`${label} : ${explain(e)}`); return fallback; } };

  // ── Notes : toutes les périodes (trimestres/semestres), dédoublonnées
  const gTab = tabs.get(P.TabLocation.Grades);
  const periods = (gTab?.periods ?? []).filter((p) => p.kind !== 0 && !/hors p/i.test(p.name));
  const current = gTab?.defaultPeriod && periods.some((p) => p.id === gTab.defaultPeriod.id) ? gTab.defaultPeriod
    : periods.find((p) => p.startDate <= now && now <= p.endDate) ?? periods.at(-1);
  const overviews = gTab ? await safe("Notes", () => Promise.all(periods.map((p) => P.gradesOverview(s, p).then((g) => [p, g]))), []) : [];
  const seen = new Set(), notes = [];
  for (const [p, g] of overviews) for (const n of g.grades) {
    const v = val(n.value), sur = val(n.outOf) ?? 20;
    if (v == null || seen.has(n.id)) continue;
    seen.add(n.id);
    notes.push({ date: day(n.date), matiere: subj(n.subject), devoir: n.comment || "Évaluation", note: v, sur,
      coefficient: n.coefficient || 1, moyenneClasse: val(n.average), periode: p.id, bonus: n.isBonus || undefined, facultatif: n.isOptional || undefined });
  }
  notes.sort((a, b) => a.date.localeCompare(b.date));
  const officiel = {};
  const curOv = overviews.find(([p]) => p.id === current?.id)?.[1];
  for (const a of curOv?.subjectsAverages ?? []) {
    const out = val(a.outOf) ?? 20, e = val(a.student), c = val(a.class_average);
    if (e != null) officiel[subj(a.subject)] = { eleve: e / out * 20, classe: c == null ? null : c / out * 20 };
  }

  // ── Devoirs (cahier de textes)
  // (les numéros d'onglets ont changé en PRONOTE 2026.2 : on interroge directement, sans se fier à « tabs »)
  const assignments = await safe("Devoirs", () => P.assignmentsFromIntervals(s, now, end), []);
  const devoirs = assignments.map((a) => ({ date: day(a.deadline), matiere: subj(a.subject), titre: htmlToText(a.description) || "Consigne non renseignée",
    source: "pronote", controle: false, rendu: !!a.done, pj: a.attachments?.length || undefined }));

  // ── Emploi du temps (7 jours) : sert aussi à repérer les contrôles annoncés
  const edt = await safe("Emploi du temps", async () => {
    const tt = await P.timetableFromIntervals(s, now, new Date(now.getTime() + 7 * 864e5));
    P.parseTimetable(s, tt, { withCanceledClasses: true, withSuperposedCanceledClasses: false, withPlannedClasses: true });
    return tt.classes.map((c) => c.is === "lesson" ? { debut: dayTime(c.startDate), fin: dayTime(c.endDate), matiere: subj(c.subject),
      salle: c.classrooms.join(", "), prof: c.teacherNames.join(", "), annule: c.canceled || undefined, statut: c.status || undefined, controle: c.test || undefined }
      : { debut: dayTime(c.startDate), fin: dayTime(c.endDate), matiere: c.title || (c.is === "detention" ? "Retenue" : "Activité"), autre: c.is,
        salle: (c.classrooms ?? []).join(", ") || c.resourceValue || "" })
      .sort((a, b) => a.debut.localeCompare(b.debut));
  }, []);
  const exams = new Set(edt.filter((c) => c.controle).map((c) => `${c.debut.slice(0, 10)}|${c.matiere}`));
  for (const d of devoirs) if (exams.has(`${d.date}|${d.matiere}`)) d.controle = true;
  for (const k of exams) { const [date, matiere] = k.split("|"); if (!devoirs.some((d) => d.date === date && d.matiere === matiere)) devoirs.push({ date, matiere, titre: "Contrôle prévu à l'emploi du temps", source: "pronote", controle: true, rendu: false }); }
  devoirs.sort((a, b) => a.date.localeCompare(b.date) || a.matiere.localeCompare(b.matiere, "fr"));

  // ── Vie scolaire : absences, retards, punitions, observations (toute l'année)
  const nTab = tabs.get(P.TabLocation.Notebook);
  let vieScolaire = null;
  if (nTab) {
    const np = nTab.periods.find((p) => /ann[ée]e/i.test(p.name)) ?? null;
    const list = np ? [np] : nTab.periods.filter((p) => p.kind !== 0 || nTab.periods.length === 1);
    const books = await safe("Vie scolaire", () => Promise.all(list.map((p) => P.notebook(s, p))), []);
    const uniq = (arr) => [...new Map(arr.map((x) => [x.id, x])).values()];
    const all = (k) => uniq(books.flatMap((b) => b[k] ?? []));
    vieScolaire = {
      absences: all("absences").map((a) => ({ debut: dayTime(a.startDate), fin: dayTime(a.endDate), justifiee: a.justified, motif: a.reason || "",
        heures: a.hoursMissed + (a.minutesMissed || 0) / 60, jours: a.daysMissed, aJustifier: a.shouldParentsJustify || undefined })).sort((a, b) => b.debut.localeCompare(a.debut)),
      retards: all("delays").map((r) => ({ date: dayTime(r.date), minutes: r.minutes, justifie: r.justified, motif: r.reason || r.justification || "" })).sort((a, b) => b.date.localeCompare(a.date)),
      punitions: all("punishments").map((p) => ({ date: day(p.dateGiven), titre: p.title, motifs: p.reasons.join(", "), par: p.giver, duree: p.durationMinutes, travail: htmlToText(p.workToDo) })).sort((a, b) => b.date.localeCompare(a.date)),
      observations: all("observations").map((o) => ({ date: day(o.date), titre: o.name, genre: ["carnet", "observation", "encouragement", "autre"][o.kind] ?? "autre",
        matiere: o.subject ? subj(o.subject) : "", texte: o.reason || "" })).sort((a, b) => b.date.localeCompare(a.date)),
    };
  }

  const data = {
    eleve: res.name, classe: res.className || "", etablissement: res.establishmentName, generatedAt: day(now),
    sources: { pronote: { ok: warnings.length === 0, ...(warnings.length ? { avertissements: warnings } : {}) } },
    periodes: periods.map((p) => ({ id: p.id, nom: p.name, court: p.name.replace(/^Trimestre\s*/i, "Trim. ").replace(/^Semestre\s*/i, "Sem. "), debut: day(p.startDate), fin: day(p.endDate) })),
    officielPeriode: current?.id, officiel, notes, devoirs, edt, vieScolaire,
  };
  return data;
}
