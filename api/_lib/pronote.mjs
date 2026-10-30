// Connecteur PRONOTE commun au PC (scripts/sync.mjs) et à l'app mobile (mobile/api/pronote.js).
// Basé sur Pawnote (API non officielle) + scripts/patch-pawnote.mjs pour PRONOTE 2026.2.
// Renvoie les données au format du dashboard (même forme que la synchro Ecole Directe),
// plus deux blocs propres à PRONOTE : emploi du temps (edt) et vie scolaire.
import * as P from "pawnote";

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
  if (n === "BadCredentialsError") return "Identifiant ou mot de passe PRONOTE incorrect.";
  if (n === "SecurityError") return "PRONOTE demande une vérification de sécurité (code PIN ou appareil à enregistrer) : connectez-vous une fois sur le site PRONOTE de l'établissement, puis réessayez.";
  if (n === "AccountDisabledError") return "Ce compte PRONOTE est désactivé.";
  if (n === "AccessDeniedError") return "Ce compte n'a pas accès à cet espace PRONOTE (élève / parent).";
  if (n === "SuspendedIPError" || n === "RateLimitedError") return "PRONOTE a temporairement bloqué les connexions : réessayez dans quelques minutes.";
  if (n === "PageUnavailableError" || n === "BusyPageError") return "Le site PRONOTE de l'établissement est indisponible ou l'adresse est incorrecte.";
  if (n === "SessionExpiredError") return "La session PRONOTE a expiré.";
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

/** Connexion : jeton mémorisé d'abord, sinon identifiant + mot de passe. */
async function connect({ url, username, password, token, deviceUUID, kind }) {
  const target = parseUrl(url);
  const base = { url: target.url, kind: kind ?? target.kind, username, deviceUUID };
  let lastErr;
  if (token) {
    try { const s = P.createSessionHandle(); return { s, refresh: await P.loginToken(s, { ...base, token }) }; }
    catch (e) { lastErr = e; if (!password) throw e; }
  }
  if (!password) throw lastErr ?? Object.assign(new Error("Mot de passe PRONOTE manquant."), { name: "BadCredentialsError" });
  const s = P.createSessionHandle();
  return { s, refresh: await P.loginCredentials(s, { ...base, password }) };
}

/**
 * Récupère et normalise les données PRONOTE d'un élève.
 * @param {object} o url, username, password?, token?, deviceUUID, days (devoirs/EDT à venir, 21 par défaut), childIndex (compte parent)
 */
export async function fetchPronote(o) {
  const days = o.days ?? 21;
  const { s, refresh } = await connect(o);
  if (o.childIndex != null && s.user.resources[o.childIndex]) P.use(s, o.childIndex);
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
  const enfants = s.user.resources.length > 1 ? s.user.resources.map((r, i) => ({ index: i, nom: r.name, classe: r.className || "" })) : undefined;
  return { data, enfants, refresh: { url: refresh.url, username: refresh.username, token: refresh.token, kind: refresh.kind } };
}
